// Netlify function: creates a Google Calendar event on the org calendar and
// invites staff as attendees. No npm dependencies — signs the service-account
// JWT with node:crypto.
//
// Required environment variables (Netlify → Site settings → Environment):
//   GOOGLE_SA_EMAIL        service account client_email
//   GOOGLE_SA_PRIVATE_KEY  service account private_key (paste with \n escapes)
//   GOOGLE_IMPERSONATE     Workspace user to act as, e.g. admin@yourdomain.com
//
// Per-calendar-type routing — one event per Calendar Type, on its own calendar.
// The chosen type decides the calendar; there is no fallback, so a missing or
// unmapped type is reported as an error rather than landing somewhere else.
//   GOOGLE_CAL_SPECIAL_EVENTS    "Special Events Calendar"
//   GOOGLE_CAL_OPS               "OPS Calendar"
//   GOOGLE_CAL_AFTER_SCHOOL      "After School Calendar"
//   GOOGLE_CAL_SDW               "SDW Calendar"
//
// Workspace Admin → Security → API controls → Domain-wide delegation:
//   add the service account Client ID with scope
//   https://www.googleapis.com/auth/calendar.events

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const b64 = obj => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
  .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function getAccessToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sub = process.env.GOOGLE_IMPERSONATE;
  if (!email || !key || !sub) throw new Error('Missing Google service-account env vars');

  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: email, sub, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(claim);
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key)
    .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token error: ' + (data.error_description || data.error));
  return data.access_token;
}

exports.handler = async (event) => {
  // Diagnostic: GET ?debug=1 reports what the function actually received.
  // Values are described, never printed in full — no secret leaves the box.
  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.debug) {
    const show = v => v == null ? null : {
      length: v.length,
      value: v.length > 60 ? v.slice(0, 30) + '…' + v.slice(-12) : v,
      hasQuotes: /^["']|["']$/.test(v),
      hasWhitespaceEdges: v !== v.trim(),
      charCodes: v.length <= 60 ? Array.from(v).map(c => c.charCodeAt(0)).join(',') : 'n/a'
    };
    const key = process.env.GOOGLE_SA_PRIVATE_KEY || '';
    let signOk = null, signErr = null;
    try {
      crypto.createSign('RSA-SHA256').update('x').sign(key.replace(/\\n/g, '\n'));
      signOk = true;
    } catch (e) { signOk = false; signErr = e.message; }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        GOOGLE_SA_EMAIL: show(process.env.GOOGLE_SA_EMAIL),
        GOOGLE_IMPERSONATE: show(process.env.GOOGLE_IMPERSONATE),
        GOOGLE_CALENDAR_ID: show(process.env.GOOGLE_CALENDAR_ID),
        privateKey: {
          length: key.length,
          startsCorrectly: key.startsWith('-----BEGIN PRIVATE KEY-----'),
          endsCorrectly: key.trimEnd().endsWith('-----END PRIVATE KEY-----'),
          usesEscapedNewlines: key.includes('\\n'),
          usesRealNewlines: key.includes('\n'),
          signWorks: signOk,
          signError: signErr
        }
      }, null, 2)
    };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // Calendar Type (as shown in the staffing modal) → Netlify env var holding its calendar ID.
  const CAL_ENV = {
    'Special Events Calendar': 'GOOGLE_CAL_SPECIAL_EVENTS',
    'OPS Calendar': 'GOOGLE_CAL_OPS',
    'After School Calendar': 'GOOGLE_CAL_AFTER_SCHOOL',
    'SDW Calendar': 'GOOGLE_CAL_SDW'
  };
  const calendarIdFor = type => {
    if (!type) throw new Error('No calendar type was chosen for this assignment');
    const envName = CAL_ENV[type];
    if (!envName) throw new Error(`"${type}" is not a known calendar type`);
    const mapped = (process.env[envName] || '').trim();
    if (!mapped) throw new Error(`${envName} is not set on this site, so "${type}" has no calendar to send from`);
    return mapped;
  };
  const toMin = t => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    return m ? +m[1] * 60 + +m[2] : null;
  };
  const hhmm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

  // Google Calendar descriptions accept a small HTML subset (b, i, u, br, a, ul/li).
  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = s => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');  // Lines ending in ":" read as headings in the reference invite, so bold them.
  const briefToHtml = text =>
    String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => {
        const t = line.trim();
        if (!t) return '';
        const html = linkify(escHtml(t));
        return /:$/.test(t) ? '<b>' + html + '</b>' : html;
      })
      .join('<br>');
  // Calendar attachments must be Drive files; anything else can only be a link.
  const driveAttachment = (url, title) => {
    if (!url || !/^https:\/\/(drive|docs)\.google\.com\//.test(url)) return null;
    return [{ fileUrl: url, title: title || 'Project guide' }];
  };

  try {
    // { title, date: 'YYYY-MM-DD', location, startTime: 'HH:MM', durationMinutes,
    //   attendees: [{ email, from, till, minutes, calendarType }] with from/till as 'HH:MM' }
    const body = JSON.parse(event.body || '{}');
    const attendees = (body.attendees || []).filter(a => a.email);
    if (!attendees.length) return { statusCode: 400, body: JSON.stringify({ error: 'No attendees' }) };

    const token = await getAccessToken();
    const tz = body.timeZone || 'America/New_York';

    // Group attendees by Calendar Type so each group becomes its own event on its
    // own calendar, spanning only that group's earliest-to-latest assigned times.
    const groups = new Map();
    attendees.forEach(a => {
      const type = a.calendarType || '';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(a);
    });

    const results = [];
    const errors = [];

    for (const [type, people] of groups) {
      let calId;
      try {
        calId = calendarIdFor(type);
      } catch (e) {
        errors.push((type || 'no calendar type') + ': ' + e.message);
        continue;
      }
      const mins = people.map(p => toMin(p.from)).filter(m => m !== null);
      const maxs = people.map(p => toMin(p.till)).filter(m => m !== null);
      const startMin = mins.length ? Math.min(...mins) : null;
      const endMin = maxs.length ? Math.max(...maxs) : null;

      const startTime = startMin !== null ? hhmm(startMin) : (body.startTime || '09:00');
      const start = (body.date || '') + 'T' + startTime + ':00';
      const dur = startMin !== null && endMin !== null && endMin > startMin
        ? endMin - startMin
        : (body.durationMinutes || 120);
      const endDate = new Date(start + 'Z');
      endDate.setUTCMinutes(endDate.getUTCMinutes() + dur);
      const end = endDate.toISOString().slice(0, 19);

      const shift = `<b>Shift:</b> ${startTime}–${end.slice(11, 16)} (New York time)`;
      const guide = body.guideUrl
        ? `<a href="${escHtml(body.guideUrl)}"><b>PROJECT GUIDE</b></a>`
        : '';
      const brief = briefToHtml(body.brief);
      const description = [brief, brief ? '<br>' : '', shift, guide].filter(Boolean).join('<br>');
      const attachments = driveAttachment(body.guideUrl, body.guideTitle);

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?sendUpdates=all&supportsAttachments=true`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: body.title || 'SplatLab event',
            location: body.location || '',
            description,
            ...(attachments ? { attachments } : {}),
            start: { dateTime: start, timeZone: tz },
            end: { dateTime: end, timeZone: tz },
            attendees: people.map(a => ({ email: a.email })),
            guestsCanSeeOtherGuests: false,
            guestsCanInviteOthers: false,
            guestsCanModify: false,
            reminders: { useDefault: true }
          })
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        errors.push((type || 'no calendar type') + ': ' + ((data.error && data.error.message) || res.status + ' Calendar API error'));
        continue;
      }
      results.push({
        calendarType: type,
        calendarId: calId,
        eventId: data.id,
        htmlLink: data.htmlLink,
        invited: people.map(a => a.email)
      });
    }

    if (!results.length)
      return { statusCode: 502, body: JSON.stringify({ error: errors.join(' | ') || 'No events created' }) };

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        events: results,
        invited: results.reduce((all, r) => all.concat(r.invited), []),
        errors
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
