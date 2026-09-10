// Netlify function: Airtable proxy for the Splat admin console.
// Keeps the PAT server-side. Env vars required:
//   AIRTABLE_TOKEN            personal access token (data.records:read + write)
//   AIRTABLE_BASE_ID          defaults to appJQfkR5k7lLG0hY
//   AIRTABLE_EVENTS_TABLE     defaults to "Events"
//   AIRTABLE_STAFF_TABLE      defaults to "Staff"
//   AIRTABLE_ASSIGN_TABLE     defaults to "Assignments"

const BASE = process.env.AIRTABLE_BASE_ID || 'appJQfkR5k7lLG0hY';
const TOKEN = process.env.AIRTABLE_TOKEN;
const T_EVENTS = process.env.AIRTABLE_EVENTS_TABLE || 'Events';
const T_STAFF = process.env.AIRTABLE_STAFF_TABLE || 'Staff';
const T_ASSIGN = process.env.AIRTABLE_ASSIGN_TABLE || 'Assignments';

const api = (table, qs) =>
  'https://api.airtable.com/v0/' + BASE + '/' + encodeURIComponent(table) + (qs ? '?' + qs : '');

async function at(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(init && init.headers) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((body.error && (body.error.message || body.error.type)) || res.statusText);
    e.status = res.status;
    e.detail = body;
    throw e;
  }
  return body;
}

async function listAll(table, qs) {
  const out = [];
  let offset;
  do {
    const q = qs + (offset ? '&offset=' + encodeURIComponent(offset) : '');
    const page = await at(api(table, q));
    out.push(...page.records);
    offset = page.offset;
  } while (offset);
  return out;
}

const f = (rec, name) => {
  const v = rec.fields[name];
  return Array.isArray(v) ? v.join(', ') : v;
};

// "M/DD/YYYY (from Date)" is a lookup — may arrive as an array or a US-format string.
function isoDate(rec) {
  let v = rec.fields['M/DD/YYYY (from Date)'];
  if (Array.isArray(v)) v = v[0];
  if (!v) return '';
  const s = String(v).trim();
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return us[3] + '-' + us[1].padStart(2, '0') + '-' + us[2].padStart(2, '0');
  const iso = s.match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : '';
}

async function getEvents() {
  // Status = Active and date after yesterday. Date filtering happens below so the
  // formula stays valid whatever type the lookup field returns.
  const qs = 'filterByFormula=' + encodeURIComponent('{Status}="Active"') + '&pageSize=100';
  const recs = await listAll(T_EVENTS, qs);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 1);
  cutoff.setHours(0, 0, 0, 0);

  return recs
    .map(r => ({
      id: r.id,
      title: f(r, 'Junction Record') || '—',
      date: isoDate(r),
      address: f(r, 'School Address (f)') || '',
      subway: f(r, 'Nearest Subway (f)') || '',
      status: f(r, 'Status') || '',
      type: '',
      slots: Number(f(r, 'Available Slots')) || 0,
      limit: Number(f(r, 'Event Users Limit')) || 0,
      signed: Number(f(r, 'SIGNED')) || 0
    }))
    .filter(e => e.date && new Date(e.date + 'T12:00:00') >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getStaff() {
  const recs = await listAll(T_STAFF, 'pageSize=100');
  return recs
    .map(r => ({
      id: r.id,
      name: [f(r, 'First Name'), f(r, 'Last Name')].filter(Boolean).join(' ').trim(),
      email: (f(r, 'Email') || '').trim(),
      phone: f(r, 'Phone') || '',
      role: f(r, 'Position') || '',
      status: f(r, 'Status') || '',
      rate: Number(f(r, 'Hourly Rate')) || 0
    }))
    .filter(s => s.email)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Resolve a staff record id from an email address (spec: match staff by email).
async function staffIdByEmail(email) {
  const safe = String(email).replace(/'/g, "\\'");
  const qs = 'filterByFormula=' + encodeURIComponent(`LOWER({Email})='${safe.toLowerCase()}'`) + '&maxRecords=1';
  const page = await at(api(T_STAFF, qs));
  return page.records[0] ? page.records[0].id : null;
}

async function createAssignments(payload) {
  const { eventId, assignments } = payload;
  if (!eventId) throw Object.assign(new Error('eventId is required'), { status: 400 });
  if (!Array.isArray(assignments) || !assignments.length)
    throw Object.assign(new Error('assignments array is empty'), { status: 400 });

  const records = [];
  const unmatched = [];
  for (const a of assignments) {
    const staffRecId = a.staffRecordId || (await staffIdByEmail(a.email));
    if (!staffRecId) { unmatched.push(a.email); continue; }
    records.push({
      fields: {
        'Staff Member': [staffRecId],
        'Event': [eventId],
        'Calendar Type': a.calendarType,
        'Start Time': a.from,
        'End Time': a.till,
        'Duration': Math.round((a.minutes / 60) * 100) / 100
      }
    });
  }
  if (!records.length)
    throw Object.assign(new Error('No staff matched by email: ' + unmatched.join(', ')), { status: 422 });

  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const res = await at(api(T_ASSIGN), {
      method: 'POST',
      body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true })
    });
    created.push(...res.records.map(r => r.id));
  }
  return { created, unmatched };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!TOKEN)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AIRTABLE_TOKEN is not set on this site' }) };

  try {
    const resource = (event.queryStringParameters || {}).resource;
    if (event.httpMethod === 'GET' && resource === 'events')
      return { statusCode: 200, headers, body: JSON.stringify({ events: await getEvents() }) };
    if (event.httpMethod === 'GET' && resource === 'staff')
      return { statusCode: 200, headers, body: JSON.stringify({ staff: await getStaff() }) };
    if (event.httpMethod === 'POST')
      return { statusCode: 200, headers, body: JSON.stringify(await createAssignments(JSON.parse(event.body || '{}'))) };
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown request' }) };
  } catch (err) {
    return {
      statusCode: err.status || 500,
      headers,
      body: JSON.stringify({ error: err.message, detail: err.detail })
    };
  }
};
