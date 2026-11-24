// Netlify function: read the OPS Google Calendar and return one row per confirmed attendee.
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD  (inclusive, in OPS_TZ)
// Uses the same service-account env vars as send-invite.js, plus:
//   GOOGLE_CAL_OPS   OPS calendar id
//   OPS_TZ           defaults to America/New_York
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TZ = process.env.OPS_TZ || 'America/New_York';
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
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token error: ' + (data.error_description || data.error));
  return data.access_token;
}

// Offset (minutes) of TZ from UTC at a given instant
function tzOffset(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
function localMidnight(iso) {
  const guess = new Date(iso + 'T00:00:00Z');
  return new Date(guess.getTime() - tzOffset(guess) * 60000);
}
const fmtDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const fmtTime = d => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d).replace(' ', '').toLowerCase();

function cleanNotes(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{2,}/g, '\n').trim();
}
// "includes 45 min lunch" → 45 unpaid minutes
function lunchMinutes(notes) {
  const m = notes.match(/(\d+)\s*(?:min|mins|minute|minutes)\.?\s*(?:unpaid\s*)?lunch/i);
  return m ? +m[1] : 0;
}

async function staffByEmail() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return new Map();
  const base = process.env.AIRTABLE_BASE_ID || 'appJQfkR5k7lLG0hY';
  const table = process.env.AIRTABLE_STAFF_MEMBERS_TABLE || 'tblI6wCqOI5iG9F0K';
  const map = new Map();
  let offset;
  try {
    do {
      const url = 'https://api.airtable.com/v0/' + base + '/' + table + '?pageSize=100&fields%5B%5D=Email&fields%5B%5D=First%20Name&fields%5B%5D=Last%20Name' + (offset ? '&offset=' + offset : '');
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const d = await res.json();
      if (!res.ok) break;
      d.records.forEach(r => {
        const e = String(r.fields['Email'] || '').trim().toLowerCase();
        if (e) map.set(e, [r.fields['First Name'], r.fields['Last Name']].filter(Boolean).join(' '));
      });
      offset = d.offset;
    } while (offset);
  } catch (_) { /* names fall back to the calendar display name */ }
  return map;
}

const { requireSession } = require('../lib/session');

exports.handler = async (event) => {
  const denied = requireSession(event);
  if (denied) return denied;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  try {
    const q = event.queryStringParameters || {};
    const cal = process.env.GOOGLE_CAL_OPS;
    if (!cal) throw new Error('GOOGLE_CAL_OPS is not set on this site');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.to || ''))
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'from and to (YYYY-MM-DD) are required' }) };

    const timeMin = localMidnight(q.from).toISOString();
    const end = new Date(q.to + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
    const timeMax = localMidnight(end.toISOString().slice(0, 10)).toISOString();

    const [token, names] = await Promise.all([getAccessToken(), staffByEmail()]);
    const events = [];
    let pageToken;
    do {
      const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal) + '/events?' + new URLSearchParams({
        timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...(pageToken ? { pageToken } : {})
      });
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const d = await res.json();
      if (!res.ok) throw new Error('Calendar error: ' + ((d.error && d.error.message) || res.statusText));
      events.push(...(d.items || []));
      pageToken = d.nextPageToken;
    } while (pageToken);

    const rows = [];
    let skippedAllDay = 0, noConfirmed = 0;
    events.forEach(ev => {
      if (ev.status === 'cancelled') return;
      if (!ev.start || !ev.start.dateTime) { skippedAllDay++; return; }
      const s = new Date(ev.start.dateTime), e = new Date(ev.end.dateTime);
      const notes = cleanNotes(ev.description);
      const totalMin = Math.round((e - s) / 60000);
      const lunch = lunchMinutes(notes);
      const paidMin = Math.max(0, totalMin - lunch);
      const confirmed = (ev.attendees || []).filter(a => a.responseStatus === 'accepted' && !a.resource);
      if (!confirmed.length) { noConfirmed++; return; }
      confirmed.forEach(a => {
        const email = String(a.email || '').toLowerCase();
        rows.push({
          event: ev.summary || '',
          date: fmtDate(s),
          attendee: names.get(email) || a.displayName || '',
          email,
          start: fmtTime(s),
          end: fmtTime(e),
          period: fmtTime(s) + ' – ' + fmtTime(e) + (fmtDate(s) !== fmtDate(e) ? ' (+1 day)' : ''),
          totalHours: +(totalMin / 60).toFixed(2),
          unpaidLunchMin: lunch,
          paidHours: +(paidMin / 60).toFixed(2),
          notes
        });
      });
    });
    return { statusCode: 200, headers, body: JSON.stringify({ rows, events: events.length, skippedAllDay, noConfirmed }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
