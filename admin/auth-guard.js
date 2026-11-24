// Load in <head> of every portal page: <script src="auth-guard.js"></script>
// Hides the page until the session is confirmed, sends signed-out visitors to
// login.html, fills [data-user] with the signed-in email and wires [data-signout].
// The real protection is server side: every Netlify function checks the session
// cookie and answers 401 without it. This script only handles the page experience.
(function () {
  const AUTH = '/.netlify/functions/auth';
  const root = document.documentElement;
  root.style.visibility = 'hidden';
  const reveal = () => { root.style.visibility = ''; };
  const toLogin = () => {
    const next = location.pathname + location.search;
    location.replace('login.html?next=' + encodeURIComponent(next));
  };

  // Session expired while working: any 401 from a portal function goes to sign in.
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await _fetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (res.status === 401 && url.indexOf('/.netlify/functions/') !== -1 && url.indexOf(AUTH) === -1) toLogin();
    return res;
  };

  function fillUser(email) {
    const run = () => {
      document.querySelectorAll('[data-user]').forEach(el => { el.textContent = email; });
      document.querySelectorAll('[data-signout]').forEach(el => {
        el.hidden = false;
        el.addEventListener('click', async () => {
          try { await _fetch(AUTH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) }); } catch (_) {}
          location.replace('login.html?signedout=1');
        });
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  }

  _fetch(AUTH, { credentials: 'same-origin' })
    .then(async r => {
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { reveal(); return; } // no backend: design preview
      if (r.status === 401) return toLogin();
      const d = await r.json();
      fillUser(d.email || '');
      reveal();
    })
    .catch(reveal);
})();
