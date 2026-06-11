exports.handler = async function(event, context) {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const token  = process.env.AIRTABLE_TOKEN;
  const base   = process.env.AIRTABLE_BASE_ID;
  const table  = process.env.AIRTABLE_TABLE || 'Events';

  if(!token || !base){
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Airtable credentials not configured in Netlify environment variables.' }),
    };
  }

  const FIELD_MAP = {
    name:        'Junction Record',
    description: 'Summarized Text',
    date:        'Formatted Date',
    category:    'Category',
    status:      'Status',
    notes:       'Notes',
  };

  try {
    let allRecords = [];
    let offset     = null;

    do {
      let url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?pageSize=100`;
      if(offset) url += `&offset=${offset}`;

      const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();

      if(!res.ok){
        const msg = data?.error?.message || data?.error?.type || `HTTP ${res.status}`;
        return {
          statusCode: res.status,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: `Airtable error: ${msg}` }),
        };
      }

      (data.records || []).forEach(r => {
        const f      = r.fields;
        const status = (f[FIELD_MAP.status] || '').toLowerCase();
        if(status !== 'active') return;

        const unwrap = v => Array.isArray(v) ? (v[0] || '') : (v || '');

        allRecords.push({
          id:      r.id,
          name:    unwrap(f[FIELD_MAP.name]),
          date:    unwrap(f[FIELD_MAP.date]) || 'TBD',
          section: unwrap(f[FIELD_MAP.category]),
          desc:    unwrap(f[FIELD_MAP.description]),
          notes:   unwrap(f[FIELD_MAP.notes]),
        });
      });

      offset = data.offset || null;
    } while(offset);

    // Sort by date ascending, TBD goes to the end
    allRecords.sort((a, b) => {
      if(a.date === 'TBD') return 1;
      if(b.date === 'TBD') return -1;
      return new Date(a.date) - new Date(b.date);
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ events: allRecords }),
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Function error: ' + err.message }),
    };
  }
};
