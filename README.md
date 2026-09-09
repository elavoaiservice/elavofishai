# Lake Granbury Fishing AI — deployment kit

One app, three ways to run it. All files stay in one folder.

## Files
- lake-granbury-planner.html — the entire app (frontend)
- server.js                  — optional backend: accounts + synced storage
                               (zero dependencies, Node 18+)
- sw.js                      — service worker: offline support
- manifest.webmanifest       — installable-app manifest
- apple-touch-icon.png,
  icon-192.png, icon-512.png — home-screen icons
- INTEGRATION.md             — brief for integrating the API into an
                               existing backend (e.g. via Claude Code)
- contract-test.js           — verifies ANY backend implements the API
                               correctly: BASE_URL=... node contract-test.js

## Option 1 — static hosting (no accounts)
Copy everything except server.js to any web folder. Serve over HTTPS.
Data stays in each visitor's browser. Add to Home Screen for the app icon.

## Option 2 — standalone backend with accounts
    node server.js                          # gated; prints an invite code, port 8787
    INVITE_CODE=secret node server.js       # invite-only, code of your choosing
    OPEN_REGISTRATION=1 node server.js      # anyone who finds it can sign up
    PORT=3000 node server.js                # custom port

Registration is gated by default. Plain `node server.js` generates an invite
code and prints it at startup — use that to create your own account. It changes
on every restart, so set INVITE_CODE to keep one. Only OPEN_REGISTRATION=1
leaves signup open to anyone who reaches the URL.

Put HTTPS in front (nginx/Caddy/Cloudflare). All user data lives in ./data —
back up that folder. Keep it running with pm2 or systemd. Each account is
capped at 64 keys, 2 MB per key, 8 MB in total.

## Option 3 — integrate into an existing backend
Give INTEGRATION.md + contract-test.js to your implementer (human or
Claude Code). Done = contract-test.js exits clean against your server. The
test creates its own accounts, so point it at a dev server with registration
open: OPEN_REGISTRATION=1 node server.js

## Notes
- HTTPS is required for GPS ("Find me"), offline mode, and secure cookies.
- Updating the app later: bump CACHE version in sw.js (v2 → v3) so cached
  copies refresh.
- Moving from local use to a server: Export JSON in the app first, Import
  on the new address — browser storage doesn't transfer across addresses.
- The USGS lake-level API this uses is slated for decommissioning in early
  2027; the app already has manual entry as fallback.
