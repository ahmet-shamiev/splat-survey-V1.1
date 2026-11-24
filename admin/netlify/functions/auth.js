// Netlify function: sign in, registration and password reset for the admin portal.
// No npm dependencies.
//
//   POST { action: 'request-link', email, mode: 'register' | 'reset' }
//        Emails a one-time "create password" link (valid 30 min). Always answers ok,
//        so the page never reveals which emails have access.
//   POST { action: 'check-link', token }            -> { email, mode } if the link is still valid
//   POST { action: 'set-password', token, password } -> saves the password (link then stops working)
//   POST { action: 'login', email, password }        -> sets the session cookie
//   POST { action: 'logout' }                        -> clears the session cookie
//   GET                                              -> { email } of the signed-in user, or 401
//
// Env vars (Netlify -> Site settings -> Environment variables):
//   AUTH_SECRET            required, 32+ random characters
//   ALLOWED_EMAILS         optional override of the 3 allowed emails, comma separated
//   AIRTABLE_TOKEN         already set for airtable.js
//   AIRTABLE_BASE_ID       already set / defaults to appJQfkR5k7lLG0hY
//   AIRTABLE_USERS_TABLE   defaults to "Portal Users"
//   Email delivery, option A (Gmail through the existing service account):
//     GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY   already set for send-invite.js
//     AUTH_MAIL_FROM       Workspace mailbox that sends the email, e.g. operations@splatlab.com
//                          (falls back to GOOGLE_IMPERSONATE). Needs the scope
//                          https://www.googleapis.com/auth/gmail.send added to the
//                          service account in Domain-wide delegation.
//   Email delivery, option B (Make / Zapier):
//     AUTH_EMAIL_WEBHOOK   if set, the function POSTs { to, subject, html, text, link } here
//                          instead of using Gmail.

const crypto = require('crypto');
// ---- Session helpers (same block in airtable.js, send-invite.js, ops-export.js) ----
const S = (() => {
  const crypto = require('crypto');
  const DEFAULT_ALLOWED = ['operations@splatlab.com', 'taylor@splatlab.com', 'ahmet@splatlab.com'];
  const COOKIE = 'sl_session', HOURS = 12;
  const allowedEmails = () => (process.env.ALLOWED_EMAILS ? process.env.ALLOWED_EMAILS.split(',') : DEFAULT_ALLOWED).map(e => e.trim().toLowerCase()).filter(Boolean);
  const isAllowed = e => allowedEmails().includes(String(e || '').trim().toLowerCase());
  const secret = () => { const s = process.env.AUTH_SECRET || ''; if (s.length < 32) throw new Error('AUTH_SECRET is missing or shorter than 32 characters'); return s; };
  const b64u = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sign = payload => { const body = b64u(JSON.stringify(payload)); return body + '.' + b64u(crypto.createHmac('sha256', secret()).update(body).digest()); };
  const verify = (token, purpose) => {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const [body, mac] = token.split('.');
    const want = crypto.createHmac('sha256', secret()).update(body).digest(), got = unb64u(mac);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    let p; try { p = JSON.parse(unb64u(body).toString('utf8')); } catch (_) { return null; }
    if (!p || p.p !== purpose || !p.exp || Date.now() / 1000 > p.exp || !isAllowed(p.e)) return null;
    return p;
  };
  const readCookie = (event, name) => {
    const raw = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
    const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
  };
  const sessionCookie = email => `${COOKIE}=${encodeURIComponent(sign({ p: 'session', e: email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + HOURS * 3600 }))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${HOURS * 3600}`;
  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const getSession = event => { try { const p = verify(readCookie(event, COOKIE), 'session'); return p ? { email: p.e } : null; } catch (_) { return null; } };
  const requireSession = event => getSession(event) ? null : { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'Not signed in', signIn: '/login.html' }) };
  return { allowedEmails, isAllowed, sign, verify, getSession, requireSession, sessionCookie, clearCookie, b64u };
})();

const BASE = process.env.AIRTABLE_BASE_ID || 'appJQfkR5k7lLG0hY';
const T_USERS = process.env.AIRTABLE_USERS_TABLE || 'Portal Users';
const LINK_MINUTES = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const json = (statusCode, data, extra = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  body: JSON.stringify(data)
});
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@"'\\]+@[^\s@"'\\]+\.[a-z]{2,}$/i.test(e);

// ---------- Airtable: one row per portal user ----------
async function at(path, init = {}) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN is not set on this site');
  const res = await fetch('https://api.airtable.com/v0/' + BASE + '/' + encodeURIComponent(T_USERS) + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Airtable: ' + ((body.error && (body.error.message || body.error.type)) || res.status));
  return body;
}
async function findUser(email) {
  const f = `LOWER({Email})='${email.replace(/'/g, "\\'")}'`;
  const d = await at('?maxRecords=1&filterByFormula=' + encodeURIComponent(f));
  return d.records && d.records[0] ? d.records[0] : null;
}
async function saveUser(rec, email, fields) {
  if (rec) return at('/' + rec.id, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) });
  return at('', { method: 'POST', body: JSON.stringify({ records: [{ fields: { Email: email, ...fields } }], typecast: true }) });
}

// ---------- Passwords (scrypt) ----------
const N = 16384, R = 8, P = 1, KEYLEN = 64;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}
function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(got, want);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Password must include at least one letter and one number.';
  return null;
}
// Fingerprint of the current password. It goes into the email link, so a link
// stops working as soon as a password is saved with it (one-time use).
const fingerprint = hash => crypto.createHash('sha256').update(String(hash || 'none')).digest('hex').slice(0, 16);

// ---------- Email ----------
async function gmailToken(sub) {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key || !sub) throw new Error('Missing Google service-account env vars for email');
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: email, sub, scope: 'https://www.googleapis.com/auth/gmail.send', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = S.b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + S.b64u(JSON.stringify(claim));
  const sig = S.b64u(crypto.createSign('RSA-SHA256').update(unsigned).sign(key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig })
  });
  const d = await res.json();
  if (!res.ok) throw new Error('Gmail token error: ' + (d.error_description || d.error));
  return d.access_token;
}

async function sendMail({ to, subject, html, text, link }) {
  if (process.env.AUTH_EMAIL_WEBHOOK) {
    const r = await fetch(process.env.AUTH_EMAIL_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html, text, link })
    });
    if (!r.ok) throw new Error('Email webhook error ' + r.status);
    return;
  }
  const from = process.env.AUTH_MAIL_FROM || process.env.GOOGLE_IMPERSONATE;
  const token = await gmailToken(from);
  const boundary = 'b' + crypto.randomBytes(8).toString('hex');
  const mime = [
    `From: SplatLab Admin <${from}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', text,
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', html,
    `--${boundary}--`
  ].join('\r\n');
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(from)}/messages/send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: S.b64u(mime) })
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error('Gmail send error: ' + ((d.error && d.error.message) || r.status));
  }
}

function linkEmail(mode, link) {
  const reset = mode === 'reset';
  const subject = reset ? 'Reset your SplatLab Admin password' : 'Finish your SplatLab Admin registration';
  const lead = reset
    ? 'We got a request to reset the password for your SplatLab Admin account.'
    : 'You started registration for the SplatLab Admin portal.';
  const btn = reset ? 'Set a new password' : 'Create my password';
  const text = `${lead}\n\n${btn}: ${link}\n\nThis link works once and expires in ${LINK_MINUTES} minutes. If you did not ask for this, you can ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;color:#1e2a2c;max-width:480px;margin:0 auto;padding:24px">
  <div style="font-size:18px;font-weight:700;color:#0d7186;margin-bottom:16px">SplatLab · Admin</div>
  <p style="font-size:15px;line-height:1.5">${lead}</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#0d7d94;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;display:inline-block">${btn}</a></p>
  <p style="font-size:13px;color:#6b7c7e;line-height:1.5">This link works once and expires in ${LINK_MINUTES} minutes. If you did not ask for this, you can ignore this email.</p>
</div>`;
  return { subject, html, text };
}

function siteUrl(event) {
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host;
  return (host ? 'https://' + host : process.env.URL || '').replace(/\/$/, '');
}

// ---------- Handler ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const s = S.getSession(event);
      return s ? json(200, { email: s.email }) : json(401, { error: 'Not signed in' });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Bad request' }); }

    if (b.action === 'request-link') {
      const email = normEmail(b.email);
      const mode = b.mode === 'reset' ? 'reset' : 'register';
      if (!validEmail(email)) return json(400, { error: 'Please enter a valid email address.' });
      if (S.isAllowed(email)) {
        const rec = await findUser(email);
        const token = S.sign({
          p: 'setpw', e: email, m: mode,
          v: fingerprint(rec && rec.fields['Password Hash']),
          exp: Math.floor(Date.now() / 1000) + LINK_MINUTES * 60
        });
        // Token goes in the #fragment, so it never reaches server logs or Referer headers.
        const link = `${siteUrl(event)}/login.html#token=${encodeURIComponent(token)}`;
        await sendMail({ to: email, link, ...linkEmail(mode, link) });
      }
      return json(200, { ok: true });
    }

    if (b.action === 'check-link' || b.action === 'set-password') {
      const p = S.verify(b.token, 'setpw');
      const bad = json(400, { error: 'This link has expired or was already used. Please request a new one.', expired: true });
      if (!p) return bad;
      const rec = await findUser(p.e);
      if (fingerprint(rec && rec.fields['Password Hash']) !== p.v) return bad;
      if (b.action === 'check-link') return json(200, { ok: true, email: p.e, mode: p.m });

      const problem = passwordProblem(b.password);
      if (problem) return json(400, { error: problem });
      await saveUser(rec, p.e, {
        'Password Hash': hashPassword(b.password),
        'Password Set': new Date().toISOString(),
        'Failed Attempts': 0,
        'Locked Until': null
      });
      return json(200, { ok: true, email: p.e });
    }

    if (b.action === 'login') {
      const email = normEmail(b.email);
      const wrong = json(401, { error: 'Email or password is incorrect. New here? Choose “Register” to create your password first.' });
      if (!S.isAllowed(email) || typeof b.password !== 'string') return wrong;
      const rec = await findUser(email);
      if (!rec || !rec.fields['Password Hash']) return wrong;

      const lockedUntil = rec.fields['Locked Until'] ? Date.parse(rec.fields['Locked Until']) : 0;
      if (lockedUntil && lockedUntil > Date.now()) {
        const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
        return json(429, { error: `Too many failed attempts. Try again in ${mins} min, or reset your password.` });
      }
      if (!checkPassword(b.password, rec.fields['Password Hash'])) {
        const fails = (+rec.fields['Failed Attempts'] || 0) + 1;
        const lock = fails >= MAX_FAILS;
        await saveUser(rec, email, {
          'Failed Attempts': lock ? 0 : fails,
          'Locked Until': lock ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null
        });
        return lock
          ? json(429, { error: `Too many failed attempts. Try again in ${LOCK_MINUTES} min, or reset your password.` })
          : wrong;
      }
      if (rec.fields['Failed Attempts'] || rec.fields['Locked Until'])
        await saveUser(rec, email, { 'Failed Attempts': 0, 'Locked Until': null });
      return json(200, { ok: true, email }, { 'Set-Cookie': S.sessionCookie(email) });
    }

    if (b.action === 'logout') return json(200, { ok: true }, { 'Set-Cookie': S.clearCookie() });

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('auth error:', e.message);
    return json(500, { error: 'Something went wrong on our side. Please try again in a minute.', detail: e.message });
  }
};
