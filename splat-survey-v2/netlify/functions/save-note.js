exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const token = process.env.AIRTABLE_TOKEN;
  const base  = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || 'Events';

  if(!token || !base) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { recordId, note } = body;
  if(!recordId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing recordId' }) };

  try {
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}/${recordId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: { Notes: note } }),
    });

    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: data?.error?.message || 'Airtable error' }) };

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
