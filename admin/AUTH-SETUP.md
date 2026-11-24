# Admin portal sign-in: setup

## What was added
- `login.html`: Sign in, Register, Forgot password, Check email, Create password, Expired link.
- `auth-guard.js`: loaded by `index.html` and `staff.html`. Sends signed-out visitors to `login.html`, shows the signed-in email and a Sign out button.
- `netlify/functions/auth.js`: request link, check link, set password, login, logout.
- `netlify/lib/session.js`: signed session cookie (HttpOnly, Secure, 12 hours) and the allowed email list.
- `airtable.js`, `send-invite.js`, `ops-export.js` now answer 401 without a valid session. This is the real protection: no data leaves the functions without sign-in.

Allowed emails (default, in `lib/session.js`):
operations@splatlab.com, taylor@splatlab.com, ahmet@splatlab.com

## 1. Airtable table
Create a table **Portal Users** in base appJQfkR5k7lLG0hY with these fields:

| Field | Type |
|---|---|
| Email | Single line text (primary) |
| Password Hash | Long text |
| Password Set | Date with time |
| Failed Attempts | Number (integer) |
| Locked Until | Date with time |

Rows are created by the function the first time someone completes registration. Nobody needs to edit them. Delete a row to force that person to register again.
The AIRTABLE_TOKEN must have access to this table (same base, so usually nothing to change).

## 2. Netlify environment variables
| Variable | Value |
|---|---|
| AUTH_SECRET | 40+ random characters. Example: `openssl rand -base64 48` |
| AUTH_MAIL_FROM | Mailbox that sends the link, e.g. `operations@splatlab.com` (falls back to GOOGLE_IMPERSONATE) |
| ALLOWED_EMAILS | Optional. Comma separated list to override the 3 default emails |
| AIRTABLE_USERS_TABLE | Optional. Default `Portal Users` |
| AUTH_EMAIL_WEBHOOK | Optional. Make/Zapier webhook URL. If set, the email is sent through it instead of Gmail. Payload: `{ to, subject, html, text, link }` |

## 3. Gmail sending (if not using the webhook)
Google Workspace Admin → Security → API controls → Domain-wide delegation → the existing service account → add the scope:
`https://www.googleapis.com/auth/gmail.send`
(keep `calendar.events` there too, comma separated).

## 4. Test
1. Open `/login.html` → Register → enter one of the 3 emails.
2. Open the email, click the link, create a password.
3. You land on Sign in with the email filled in. Sign in.
4. Open `/.netlify/functions/airtable?resource=events` in a private window: it must answer 401.

## Notes
- Links work once (they stop working as soon as a password is saved) and expire in 30 minutes.
- Links carry the token after `#`, so it never reaches server logs.
- 5 wrong passwords lock the account for 15 minutes. Reset password still works during the lock.
- Changing AUTH_SECRET signs everyone out and kills all open links.
- `preview.html` and `uploads/` are not protected by the guard. Remove them from the deploy if they hold real data.
