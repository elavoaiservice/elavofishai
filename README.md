# ElavoFishAI

A multi-user, social fishing app: sign in with a magic link, add any public lake,
get AI + community fishing intelligence for it, log trips, and share spots and
logs with the friends you choose. Grew out of a single-lake Lake Granbury PWA —
the fishing engine (solunar, weather, water temp, scoring, map, trip log,
CSV/GPX) is the same one, now backed by a real stack.

Stack: TypeScript + Fastify + Prisma + Postgres (Node 22), serving the PWA and
`/api/*` same-origin. Deployed with Docker Compose on port **3100**.

## Layout

    public/            the PWA + marketing landing (static, served same-origin)
      landing.html       public front door  →  /
      login.html         magic-link sign-in →  /login
      signup.html        self-registration  →  /signup
      index.html         the planner app    →  /app   (session required)
      admin.html         Command Center     →  /admin (admin login + email MFA)
      sw.js, manifest.webmanifest, icons
    server/
      src/routes/        auth, me, kv, lakes, ai, social, messages, admin, health
      src/services/      magic links, email, lake search, AI profiles, day plans,
                         catch photo ID, Granbury seed
      src/lib/           sessions, admin auth, crypto, rate limits, sharing rules
      prisma/schema.prisma + migrations/
      tools/             bake-changelog.js (history baked into the image)
      test/              node:test suites (auth, sharing/visibility, unit)
      Dockerfile, docker-start.sh
    scripts/             test.sh, backup.sh, verify-backup.sh, upgrade-agent.sh
                         + launchd plists (backup, upgrade)
    docker-compose.yml   postgres + app
    docs/ELAVOFISHAI-PLAN.md   the build plan and phase status

Legacy from the single-file era, kept for reference only: `legacy-server.js.bak`,
`INTEGRATION.md`, `contract-test.js` (the old 6-route KV contract, which the
`/api/kv/:key` routes still satisfy).

## Run it — Docker Compose

    cp .env.example .env        # set PG_PASSWORD, ADMIN_*, CONFIG_ENCRYPTION_KEY
    docker compose up -d --build

App on http://localhost:3100 (Postgres stays internal — not published). The
container applies any pending Prisma migrations on start and seeds the
hand-verified Granbury lake profile. Rebuild after a pull:

    git pull && docker compose up -d --build

A database created before migrations existed (by the old `prisma db push`
path) has no migration history; the entrypoint detects that and baselines it
against `0001_init` once, then migrates forward normally.

## Run it — local development

Node 22 and a Postgres you can reach.

    cd server
    npm install
    export DATABASE_URL=postgres://elavofish:elavofish@localhost:5432/elavofish
    npm run prisma:generate
    npm run migrate:deploy
    npm run dev            # tsx watch, http://localhost:3100

Other scripts: `npm run build`, `npm start`, `npm run typecheck`, `npm test`,
and `npm run migrate:dev` to author a new migration after editing
`prisma/schema.prisma`. Don't use `db:push` against anything holding real data —
it reshapes tables in place and can drop columns.

## Configuration

Set in `.env` for compose. The AI, email, base-URL and messaging settings can
also be edited at runtime in the admin Settings GUI, which overlays the database
on top of `process.env` and reloads in place (secrets encrypted at rest with
`CONFIG_ENCRYPTION_KEY`).

| Variable | What it does |
| --- | --- |
| `PG_PASSWORD` | Postgres password; compose builds `DATABASE_URL` from it |
| `PUBLIC_BASE_URL` | Origin the app is reached at — magic-link URLs, cookies |
| `COOKIE_SECURE` | `true` only behind HTTPS; LAN over http → `false` |
| `DEV_SHOW_MAGIC_LINK` | `1` returns the sign-in link instead of emailing it — **anyone who can reach the app can then sign in as any email**, so it defaults to `0` |
| `ALLOW_INSECURE_DEV_LOGIN` | required alongside the above for a production build to start at all |
| `RESEND_API_KEY`, `EMAIL_FROM` | real email for magic links + admin MFA |
| `ANTHROPIC_API_KEY` | AI lake profiles, day planner, catch-photo logging |
| `AI_PROFILE_MODEL` | `claude-opus-4-8` (default) or `claude-sonnet-5` (cheaper) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL` | bootstraps the first admin |
| `CONFIG_ENCRYPTION_KEY` | encrypts stored config secrets — `openssl rand -hex 32` |
| `DEFAULT_MESSAGE_PRIVACY` | who can DM a new user: everyone / friends / nobody (admin GUI) |

Without an Anthropic key the engine still works — AI profiles and plans stay
pending.

**Sign-in links.** With `RESEND_API_KEY` set, magic links are emailed and the
API says nothing more than "check your inbox". Set `EMAIL_FROM` to a sender on
a domain you have verified in Resend — without it the shared
`onboarding@resend.dev` sender is used, which only delivers to your own Resend
account address, so every other angler silently gets nothing. Admin → **System
health** shows the real delivery record (sent/failed, last error) and warns
about exactly this; admin → **Sign-in links** lists recent link requests and can
mint a one-time link when delivery is down (audited — it signs that person in).
When a link can neither be emailed nor shown, the API returns an error saying so
instead of a hollow "check your email". Dev/console mode
(`DEV_SHOW_MAGIC_LINK=1`) hands the link straight back to whoever asked for it,
which is an account takeover for any address they care to type — so it is off by
default, a production build refuses to start with it on unless
`ALLOW_INSECURE_DEV_LOGIN=1` says you mean it, and even then the link is only
ever returned to a caller on a private network (127.0.0.0/8, 10/8, 192.168/16,
172.16–31, IPv6 loopback/ULA).

## Admin Command Center

`/admin` — separate from user magic-link sign-in: username + password + a
one-time code emailed on login. Covers metrics, user and admin management,
lakes and profiles, recent activity, audit log, changelog, system health, the
Settings GUI, and upgrade-from-git.

**Changelog** (`/api/admin/changelog`) is the shipped history of the app, the
same feature ElavoAI has: every commit behind the running build, classified by
conventional-commit type (feature / fix / perf / refactor / …), searchable
across subject, body, scope, sha and changed files, and grouped by day in
Central Time. Commits pushed but not yet in the running build appear on top
marked "not deployed". The container has no `.git`, so the history is baked
into `dist/changelog.json` at image build time (like `build-info.json`) and the
service falls back to live `git log` when running from a checkout.

**Upgrade from Git** signals a host-side agent rather than touching git or
Docker itself: the API writes `/deploy/trigger` (compose mounts `./deploy`
there), and the agent on the host fast-forwards the checkout, rebuilds, restarts
and waits for `/health/ready`, streaming progress to `deploy/status.log` — which
the admin panel tails live. Run the agent as the user that owns the checkout:

    ./scripts/upgrade-agent.sh          # watch for trigger files
    ./scripts/upgrade-agent.sh --once   # do one upgrade now

On the Mini it runs as a launchd job
(`scripts/com.elavoai.elavofishai.upgrade.plist`): `WatchPaths` fires
`upgrade-agent.sh --once` the moment the trigger file appears, so there's no
polling loop to keep alive. Edit the paths, copy to `~/Library/LaunchAgents`,
`launchctl load`. Set `DEPLOY_DIR` in `.env` when the shared directory lives
outside the checkout (the Mini uses `~/efa-deploy`) — compose mounts that same
path at `/deploy`, so agent and app always agree. Without a running agent the
button writes a trigger nothing acts on; without the mount the tab reports "not
configured". The version display compares the commit
baked into the image at build time against the latest commit on the tracked
branch of `elavoaiservice/elavofishai`.

## API

Same-origin under `/api/*`, all `Cache-Control: no-store`.

- **Auth:** `POST /api/auth/request-link`, `GET /api/auth/verify`,
  `POST /api/auth/logout`, `GET /api/me`, `GET/PATCH /api/me/profile`
- **Lakes:** `GET /api/lakes/search` (OSM + DB), `POST /api/lakes`,
  `GET /api/lakes/:id`, `GET/POST /api/me/lakes`, set home, active lake
- **Fishing data:** `POST /api/lakes/:id/spots|catches|waypoints`,
  `GET /api/lakes/:id/mine`, `DELETE /api/spots|catches|waypoints/:id`,
  `GET /api/lakes/:id/feed` (friends' shared), `GET/PUT /api/kv/:key`
- **AI:** `POST /api/ai/day-plan`, `POST /api/ai/identify-catch`,
  `POST /api/lakes/:id/profile/regenerate`, `GET /api/ai/status`
- **Social:** friends request/accept/decline, groups + membership, direct messages,
  `GET/PUT /api/me/sharing` (default scope per data type)
- **Admin:** login/MFA, metrics, users, admins, config, upgrade, lakes, health, audit,
  changelog, `GET /api/admin/magic-links`, `POST /api/admin/signin-link`
- **Ops:** `GET /health`, `GET /health/ready`

External data, all free and keyless: Open-Meteo (weather), USGS Water Services
(lake level), OSM Nominatim (lake search).

## Sharing model

Every spot, catch and waypoint carries its own visibility — `private`,
`friends`, `group` (one of your friend groups) or `public` — and each user sets
a default per data type under **Sharing defaults** in the Friends tab
(`SharingPref`). A create request that omits `visibility` gets that default; a
new user's default is "all friends" until they change it. The feed for a lake
resolves the whole scale: you see a friend's record when it is public, shared
with friends, or shared with a group you belong to — never otherwise.

## Data and backups

Everything lives in the `pgdata` Docker volume. `scripts/backup.sh` dumps it,
gzips it, checks the dump isn't truncated and prunes anything older than
`KEEP_DAYS` (default 14):

    ./scripts/backup.sh                 # → backups/elavofish-<stamp>.sql.gz

Run it nightly from cron on the Mini:

    0 3 * * *  cd /path/to/elavofishai && ./scripts/backup.sh >> backups/backup.log 2>&1

Restore:

    gunzip -c backups/elavofish-<stamp>.sql.gz | \
      docker compose exec -T postgres psql -U elavofish elavofish

## Tests

    ./scripts/test.sh        # throwaway Postgres, real migrations, full suite
    cd server && npm test    # unit tests only (integration suites skip)

`scripts/test.sh` starts a disposable `postgres:16`, applies the committed
migrations to it (so a broken migration fails the run), and executes the
`node:test` suites in `server/test`: magic-link sign-in and session lifecycle,
and the visibility rules — private stays private, group records reach that group
only, and you can't share into a group you don't belong to.

## Notes

- HTTPS is required for GPS ("Find me"), offline mode, and Secure cookies.
- After changing anything in `public/`, bump `CACHE` in `sw.js` (`elavofishai-v11`
  → `v12`) so installed copies refresh.
- The planner is account-gated: `/app` redirects anonymous visitors to `/login`.
- The USGS lake-level API is slated for decommissioning in early 2027; the app
  already has manual entry as a fallback.
