// Shared session helpers for the SplatLab admin portal.
// No npm dependencies: HMAC-signed tokens with node:crypto.
//
// Env vars:
//   AUTH_SECRET     long random string (at least 32 chars). Signs session
//                   cookies and email links. Changing it signs everyone out.
//   ALLOWED_EMAILS  optional, comma separated. Overrides the default list below.

const crypto = require('crypto');

const DEFAULT_ALLOWED = ['operations@splatlab.com', 'taylor@splatlab.com', 'ahmet@splatlab.com'];
const COOKIE = 'sl_session';
const SESSION_HOURS = 12;

const allowedEmails = () =>
  (process.env.ALLOWED_EMAILS ? process.env.ALLOWED_EMAILS.split(',') : DEFAULT_ALLOWED)
    .map(e => e.trim().toLowerCase()).filter(Boolean);

const isAllowed = email => allowedEmails().includes(String(email || '').trim().toLowerCase());

function secret() {
  const s = process.env.AUTH_SECRET || '';
  if (s.length < 32) throw new Error('AUTH_SECRET is missing or shorter than 32 characters');
  return s;
}

const b64u = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// token = base64url(json) + "." + base64url(hmac)
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest();
  return body + '.' + b64u(mac);
}

function verify(token, purpose) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const want = crypto.createHmac('sha256', secret()).update(body).digest();
  const got = unb64u(mac);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(unb64u(body).toString('utf8')); } catch (_) { return null; }
  if (!p || p.p !== purpose) return null;
  if (!p.exp || Date.now() / 1000 > p.exp) return null;
  if (!isAllowed(p.e)) return null;
  return p;
}

function readCookie(event, name) {
  const raw = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

function sessionCookie(email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const token = sign({ p: 'session', e: email.toLowerCase(), exp });
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`;
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// Returns { email } for a valid session, or null.
function getSession(event) {
  try { const p = verify(readCookie(event, COOKIE), 'session'); return p ? { email: p.e } : null; }
  catch (_) { return null; }
}

// Use at the top of every protected function:
//   const denied = requireSession(event); if (denied) return denied;
function requireSession(event) {
  if (getSession(event)) return null;
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: 'Not signed in', signIn: '/login.html' })
  };
}

module.exports = { allowedEmails, isAllowed, sign, verify, getSession, requireSession, sessionCookie, clearCookie, b64u };
