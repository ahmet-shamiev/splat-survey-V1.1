// Netlify function: creates a Google Calendar event on the org calendar and
// invites staff as attendees. No npm dependencies — signs the service-account
// JWT with node:crypto.
//
// Required environment variables (Netlify → Site settings → Environment):
//   GOOGLE_SA_EMAIL        service account client_email
//   GOOGLE_SA_PRIVATE_KEY  service account private_key (paste with \n escapes)
//   GOOGLE_IMPERSONATE     Workspace user to act as, e.g. admin@yourdomain.com
//   GOOGLE_CALENDAR_ID     calendar to write to (default: primary)
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

  try {
    // { title, date: 'YYYY-MM-DD', location, startTime: 'HH:MM', durationMinutes,
    //   attendees: [{ email, from, till, minutes, calendarType }] with from/till as 'HH:MM' }
    const body = JSON.parse(event.body || '{}');
    const attendees = (body.attendees || []).filter(a => a.email);
    if (!attendees.length) return { statusCode: 400, body: JSON.stringify({ error: 'No attendees' }) };

    const token = await getAccessToken();
    const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
    const tz = body.timeZone || 'America/New_York';
    const start = (body.date || '') + 'T' + (body.startTime || '09:00') + ':00';
    const mins = body.durationMinutes || 120;
    const endDate = new Date(start + 'Z');
    endDate.setUTCMinutes(endDate.getUTCMinutes() + mins);
    const end = endDate.toISOString().slice(0, 19);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: body.title || 'SplatLab event',
          location: body.location || '',
          description: attendees
            .map(a => {
              const dur = a.minutes ? ` (${Math.floor(a.minutes / 60)}h ${String(a.minutes % 60).padStart(2, '0')}m)` : '';
              const range = a.from && a.till ? `${a.from}–${a.till}${dur}` : dur.trim();
              return `${a.email}: ${range}${a.calendarType ? ' · ' + a.calendarType : ''}`;
            })
            .join('\n'),
          start: { dateTime: start, timeZone: tz },
          end: { dateTime: end, timeZone: tz },
          attendees: attendees.map(a => ({ email: a.email })),
          guestsCanSeeOtherGuests: true,
          reminders: { useDefault: true }
        })
      }
    );
    const data = await res.json();
    if (!res.ok) return { statusCode: res.status, body: JSON.stringify({ error: data.error?.message || 'Calendar API error' }) };

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, eventId: data.id, htmlLink: data.htmlLink, invited: attendees.map(a => a.email) })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
