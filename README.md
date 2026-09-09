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
    node server.js                          # open registration, port 8787
    INVITE_CODE=secret node server.js       # invite-only registration
    PORT=3000 node server.js                # custom port
Put HTTPS in front (nginx/Caddy/Cloudflare). All user data lives in ./data —
back up that folder. Keep it running with pm2 or systemd.

## Option 3 — integrate into an existing backend
Give INTEGRATION.md + contract-test.js to your implementer (human or
Claude Code). Done = contract-test.js exits clean against your server.

## Notes
- HTTPS is required for GPS ("Find me"), offline mode, and secure cookies.
- Updating the app later: bump CACHE version in sw.js (v2 → v3) so cached
  copies refresh.
- Moving from local use to a server: Export JSON in the app first, Import
  on the new address — browser storage doesn't transfer across addresses.
- The USGS lake-level API this uses is slated for decommissioning in early
  2027; the app already has manual entry as fallback.
