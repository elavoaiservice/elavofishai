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
      prisma/schema.prisma
      Dockerfile, docker-start.sh
    docker-compose.yml   postgres + app
    docs/ELAVOFISHAI-PLAN.md   the build plan and phase status

Legacy from the single-file era, kept for reference only: `legacy-server.js.bak`,
`INTEGRATION.md`, `contract-test.js` (the old 6-route KV contract, which the
`/api/kv/:key` routes still satisfy).

## Run it — Docker Compose

    cp .env.example .env        # set PG_PASSWORD, ADMIN_*, CONFIG_ENCRYPTION_KEY
    docker compose up -d --build

App on http://localhost:3100 (Postgres stays internal — not published). The
container runs `prisma db push` on start and seeds the hand-verified Granbury
lake profile. Rebuild after a pull:

    git pull && docker compose up -d --build

## Run it — local development

Node 22 and a Postgres you can reach.

    cd server
    npm install
    export DATABASE_URL=postgres://elavofish:elavofish@localhost:5432/elavofish
    npm run prisma:generate
    npm run db:push
    npm run dev            # tsx watch, http://localhost:3100

Other scripts: `npm run build`, `npm start`, `npm run typecheck`,
`npm run migrate:dev` / `migrate:deploy` (once migrations are committed — the
prototype still uses `db push`).

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
| `DEV_SHOW_MAGIC_LINK` | `1` returns and logs the sign-in link instead of emailing |
| `RESEND_API_KEY`, `EMAIL_FROM` | real email for magic links + admin MFA |
| `ANTHROPIC_API_KEY` | AI lake profiles, day planner, catch-photo logging |
| `AI_PROFILE_MODEL` | `claude-opus-4-8` (default) or `claude-sonnet-5` (cheaper) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL` | bootstraps the first admin |
| `CONFIG_ENCRYPTION_KEY` | encrypts stored config secrets — `openssl rand -hex 32` |
| `DEFAULT_MESSAGE_PRIVACY` | who can DM a new user: everyone / friends / nobody (admin GUI) |

Without an Anthropic key the engine still works — AI profiles and plans stay
pending. Without a Resend key, magic links fall back to dev/console mode.

## Admin Command Center

`/admin` — separate from user magic-link sign-in: username + password + a
one-time code emailed on login. Covers metrics, user and admin management,
lakes and profiles, recent activity, audit log, system health, the Settings GUI,
and upgrade-from-git.

**Upgrade from Git** signals a host-side agent rather than touching git or
Docker itself: the API writes `/deploy/trigger`, the host watcher pulls,
rebuilds and restarts, writing progress to `/deploy/status.log`. It shows as
"not configured" until a `/deploy` volume is mounted into the app container —
compose does not mount one yet. The version display compares the commit baked
into the image at build time against the latest commit on the tracked branch of
`elavoaiservice/elavofishai`.

## API

Same-origin under `/api/*`, all `Cache-Control: no-store`.

- **Auth:** `POST /api/auth/request-link`, `GET /api/auth/verify`,
  `POST /api/auth/logout`, `GET /api/me`, `GET/PATCH /api/me/profile`
- **Lakes:** `GET /api/lakes/search` (OSM + DB), `POST /api/lakes`,
  `GET /api/lakes/:id`, `GET/POST /api/me/lakes`, set home, active lake
- **Fishing data:** `POST /api/lakes/:id/spots|catches`, `GET /api/lakes/:id/mine`,
  `GET /api/lakes/:id/feed` (friends' shared), `GET/PUT /api/kv/:key`
- **AI:** `POST /api/ai/day-plan`, `POST /api/ai/identify-catch`,
  `POST /api/lakes/:id/profile/regenerate`, `GET /api/ai/status`
- **Social:** friends request/accept/decline, groups + membership, direct messages
- **Admin:** login/MFA, metrics, users, admins, config, upgrade, lakes, health, audit
- **Ops:** `GET /health`, `GET /health/ready`

External data, all free and keyless: Open-Meteo (weather), USGS Water Services
(lake level), OSM Nominatim (lake search).

## Data and backups

Everything lives in the `pgdata` Docker volume. Back it up:

    docker compose exec -T postgres pg_dump -U elavofish elavofish > backup.sql

## Notes

- HTTPS is required for GPS ("Find me"), offline mode, and Secure cookies.
- After changing anything in `public/`, bump `CACHE` in `sw.js` (`elavofishai-v10`
  → `v11`) so installed copies refresh.
- The planner is account-gated: `/app` redirects anonymous visitors to `/login`.
- The USGS lake-level API is slated for decommissioning in early 2027; the app
  already has manual entry as a fallback.
