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
  return flat(v);
};

// Airtable returns plain strings for most fields, but AI / rich-text fields come
// back as objects ({ state, value, isStale }) and lookups as arrays of either.
function flat(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (typeof v.value === 'string') return v.value;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.url === 'string') return v.url;
    return '';
  }
  return String(v);
}

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
      brief: f(r, 'Task Description Summary') || '',
      guideUrl: (f(r, 'Project Guide URL') || '').trim(),
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

// Write an edited brief back onto the Events record.
async function updateEventBrief(payload) {
  const { eventId, brief } = payload;
  if (!eventId) throw Object.assign(new Error('eventId is required'), { status: 400 });
  const field = process.env.AIRTABLE_BRIEF_FIELD || 'Task Description Summary';
  try {
    const res = await at(api(T_EVENTS) + '/' + eventId, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [field]: String(brief == null ? '' : brief) }, typecast: true })
    });
    return { ok: true, brief: flat(res.fields[field]) };
  } catch (e) {
    if (e.status === 422 || /computed|not writable|invalid.*field/i.test(e.message || ''))
      throw Object.assign(
        new Error(`"${field}" is generated by Airtable AI, so the API cannot write to it. Point AIRTABLE_BRIEF_FIELD at a plain long-text field to save edits.`),
        { status: 422 }
      );
    throw e;
  }
}

// Existing Assignments grouped by event id. Two reads: raw (record ids for Event /
// Staff links) and string-format (so the Calendar Type link comes back as its name).
async function getAssignments(eventIds) {
  const want = new Set(eventIds);
  if (!want.size) return {};
  // No field filter: optional fields (Calendar Event ID) may not exist yet in every base.
  const [raw, str] = await Promise.all([
    listAll(T_ASSIGN, 'pageSize=100'),
    listAll(T_ASSIGN, 'pageSize=100&cellFormat=string&timeZone=America%2FNew_York&userLocale=en-us')
  ]);
  const posName = new Map(str.map(r => [r.id, String(r.fields['Position'] || '').split(',')[0].trim()]));
  const calName = new Map(str.map(r => [r.id, String(r.fields['Calendar Type'] || '').split(',')[0].trim()]));
  const out = {};
  raw.forEach(r => {
    const evId = (r.fields['Event'] || [])[0];
    if (!want.has(evId)) return;
    (out[evId] = out[evId] || []).push({
      id: r.id,
      staffId: (r.fields['Staff Member'] || [])[0] || '',
      calendarType: calName.get(r.id) || '',
      position: posName.get(r.id) || '',
      from: flat(r.fields['Start Time']),
      till: flat(r.fields['End Time']),
      calEventId: flat(r.fields['Calendar Event ID']) || '',
      created: r.createdTime
    });
  });
  Object.values(out).forEach(list => list.sort((a, b) => a.created.localeCompare(b.created)));
  return out;
}

async function updateAssignments(updates) {
  // Only the keys present on each update are written.
  const records = updates.map(u => {
    const f = {};
    if (u.staffRecordId) f['Staff Member'] = [u.staffRecordId];
    if (u.calendarType) f['Calendar Type'] = [u.calendarType];
    if (u.position !== undefined) f['Position'] = u.position || null;
    if (u.from !== undefined) f['Start Time'] = u.from;
    if (u.till !== undefined) f['End Time'] = u.till;
    if (u.date) f[OFFICE_DATE] = u.date;
    if (u.description !== undefined) f[DESC_FIELD] = u.description;
    if (u.minutes != null) f['Duration'] = Math.round((u.minutes / 60) * 100) / 100;
    // Raised only when the hours actually change; an Airtable automation reacts and clears it.
    if (u.hoursChanged) f['Hours Changed'] = true;
    if ('calEventId' in u) f['Calendar Event ID'] = u.calEventId || '';
    return { id: u.id, fields: f };
  });
  const updated = [];
  for (let i = 0; i < records.length; i += 10) {
    const res = await at(api(T_ASSIGN), { method: 'PATCH', body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }) });
    updated.push(...res.records.map(r => r.id));
  }
  return { updated };
}

// Snapshot each assignment (incl. its Payroll link) BEFORE deleting, then send it to Zapier.
// The browser never needs to know the Payroll ID — the server reads it from the record.
const PAYROLL_FIELD = process.env.AIRTABLE_PAYROLL_FIELD || 'Payroll';
const ZAPIER_HOOK_URL = process.env.ZAPIER_HOOK_URL || 'https://hooks.zapier.com/hooks/catch/11843729/4mjtdvj/';

async function snapshotAssignments(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const formula = 'OR(' + chunk.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    const [raw, str] = await Promise.all([
      listAll(T_ASSIGN, 'pageSize=100&filterByFormula=' + encodeURIComponent(formula)),
      listAll(T_ASSIGN, 'pageSize=100&cellFormat=string&timeZone=America%2FNew_York&userLocale=en-us&filterByFormula=' + encodeURIComponent(formula))
    ]);
    const names = new Map(str.map(r => [r.id, r.fields]));
    raw.forEach(r => {
      const f = r.fields, n = names.get(r.id) || {};
      out.push({
        assignmentId: r.id,
        payrollId: (f[PAYROLL_FIELD] || [])[0] || '',
        payrollIds: f[PAYROLL_FIELD] || [],
        eventId: (f['Event'] || [])[0] || '',
        eventName: n['Event'] || '',
        staffId: (f['Staff Member'] || [])[0] || '',
        staffName: n['Staff Member'] || '',
        calendarType: n['Calendar Type'] || '',
        from: flat(f['Start Time']),
        till: flat(f['End Time']),
        hours: f['Duration'] ?? null,
        calendarEventId: flat(f['Calendar Event ID']) || '',
        assignmentType: (f['Event'] || []).length ? 'event' : 'office',
        officeDate: String(flat(f[OFFICE_DATE]) || '').slice(0, 10)
      });
    });
  }
  return out;
}

async function notifyZapier(records) {
  if (!ZAPIER_HOOK_URL) return { sent: 0, skipped: 'ZAPIER_HOOK_URL not set' };
  const deletedAt = new Date().toISOString();
  let sent = 0; const errors = [];
  // One webhook per assignment so each Zap run handles one Payroll record.
  for (const rec of records) {
    try {
      const r = await fetch(ZAPIER_HOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleted', deletedAt, ...rec })
      });
      if (r.ok) sent++; else errors.push(rec.assignmentId + ': ' + r.status);
    } catch (e) { errors.push(rec.assignmentId + ': ' + e.message); }
  }
  return { sent, errors };
}

async function deleteAssignments(ids) {
  let snapshot = [];
  try { snapshot = await snapshotAssignments(ids); } catch (e) { console.error('[snapshot]', e); }
  const deleted = [];
  for (let i = 0; i < ids.length; i += 10) {
    const qs = ids.slice(i, i + 10).map(id => 'records%5B%5D=' + encodeURIComponent(id)).join('&');
    const res = await at(api(T_ASSIGN, qs), { method: 'DELETE' });
    deleted.push(...res.records.map(r => r.id));
  }
  const zapier = await notifyZapier(snapshot.filter(r => deleted.includes(r.assignmentId)));
  if (zapier.errors && zapier.errors.length) console.error('[zapier]', zapier.errors);
  return { deleted, zapier };
}

// ---- Office work: OPS-only assignments with no Event, dated by OFFICE_DATE ----
const OFFICE_DATE = process.env.AIRTABLE_OFFICE_DATE_FIELD || 'Office Date';
const DESC_FIELD = process.env.AIRTABLE_ASSIGN_DESC_FIELD || 'Assignment Description';

async function getOfficeAssignments() {
  const formula = `AND({Event}='', {${OFFICE_DATE}}!='', IS_AFTER({${OFFICE_DATE}}, DATEADD(TODAY(), -2, 'days')))`;
  const recs = await listAll(T_ASSIGN, 'pageSize=100&filterByFormula=' + encodeURIComponent(formula));
  return recs.map(r => ({
    id: r.id,
    staffId: (r.fields['Staff Member'] || [])[0] || '',
    date: String(flat(r.fields[OFFICE_DATE]) || '').slice(0, 10),
    from: flat(r.fields['Start Time']),
    till: flat(r.fields['End Time']),
    calEventId: flat(r.fields['Calendar Event ID']) || '',
    description: flat(r.fields[DESC_FIELD]) || ''
  })).sort((a, b) => (a.date + parseClock(a.from)).localeCompare(b.date + parseClock(b.from)));
}
// '9:30am' → '0930' for sorting
function parseClock(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return '9999';
  const h = (+m[1] % 12) + (m[3] && m[3].toLowerCase() === 'pm' ? 12 : 0);
  return String(h).padStart(2, '0') + m[2];
}

async function createOfficeAssignments(payload) {
  const { date, assignments } = payload;
  if (!date) throw Object.assign(new Error('date is required'), { status: 400 });
  if (!Array.isArray(assignments) || !assignments.length)
    throw Object.assign(new Error('assignments array is empty'), { status: 400 });
  const records = assignments.map(a => ({
    fields: {
      'Staff Member': [a.staffRecordId],
      [OFFICE_DATE]: date,
      ...(payload.description ? { [DESC_FIELD]: payload.description } : {}),
      'Calendar Type': ['OPS Calendar'],
      'Start Time': a.from,
      'End Time': a.till,
      'Duration': Math.round((a.minutes / 60) * 100) / 100
    }
  }));
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const res = await at(api(T_ASSIGN), { method: 'POST', body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }) });
    created.push(...res.records.map(r => r.id));
  }
  return { created };
}

async function createAssignments(payload) {
  if (payload.office) return createOfficeAssignments(payload);
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
        // Linked-record field: typecast matches these names against the
        // calendar table's primary field (or creates them if absent).
        'Calendar Type': a.calendarType ? [a.calendarType] : undefined,
        'Position': a.position || undefined,
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
    if (event.httpMethod === 'GET' && resource === 'events') {
      const events = await getEvents();
      const byEvent = await getAssignments(events.map(e => e.id));
      events.forEach(e => { e.assignments = byEvent[e.id] || []; });
      return { statusCode: 200, headers, body: JSON.stringify({ events }) };
    }
    if (event.httpMethod === 'DELETE') {
      const ids = String((event.queryStringParameters || {}).ids || '').split(',').filter(Boolean);
      if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ids is required' }) };
      return { statusCode: 200, headers, body: JSON.stringify(await deleteAssignments(ids)) };
    }
    if (event.httpMethod === 'PATCH' && resource === 'assignments')
      return { statusCode: 200, headers, body: JSON.stringify(await updateAssignments(JSON.parse(event.body || '{}').updates || [])) };
    if (event.httpMethod === 'GET' && resource === 'office')
      return { statusCode: 200, headers, body: JSON.stringify({ office: await getOfficeAssignments() }) };
    if (event.httpMethod === 'GET' && resource === 'staff')
      return { statusCode: 200, headers, body: JSON.stringify({ staff: await getStaff() }) };
    if (event.httpMethod === 'PATCH')
      return { statusCode: 200, headers, body: JSON.stringify(await updateEventBrief(JSON.parse(event.body || '{}'))) };
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
