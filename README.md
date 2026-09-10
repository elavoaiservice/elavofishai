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
- **Social:** friends request/accept/decline, `POST/DELETE /api/friends/:id/block`,
  groups + membership, direct messages, `GET/PUT /api/me/sharing`
- **Admin:** login/MFA, metrics, users, admins, config, upgrade, lakes, health, audit,
  changelog, `GET /api/admin/magic-links`, `POST /api/admin/signin-link`
- **Ops:** `GET /health`, `GET /health/ready`

External data, all free and keyless: Open-Meteo (weather), USGS Water Services
(lake level), OSM Nominatim (lake search).

## First run

A new account gets no lake. It used to be handed Lake Granbury, which was right
when Granbury *was* the product and wrong the moment anyone else could sign up —
every number in the app is lake-specific, so a Florida angler would have been
shown a Texas reservoir's brush piles with total confidence. `/api/me/active-lake`
answers `needsLake: true` until they choose, and the app opens a three-step
first run: pick your water (search → add → set home → AI guide generated), tell
us how you fish (name, home town, boat or bank, favorite species, go-to lure,
years fishing), and choose who sees your spots by default. Steps two and three
are skippable and write only profile fields; the demo lake stays available as an
explicit "just show me" escape hatch (`POST /api/me/lakes/granbury`). Everything
collected is editable later under Settings → Profile.

## App layout

The angler-facing app follows ElavoAI's dashboard shape: a sticky sidebar card
on desktop with flat primary items over collapsible groups (Lake guide,
Settings), a four-item bottom nav plus drawer on mobile, and a page
title/subtitle above each view. Every view has a hash route.

The primary nav is four items — **Today**, **Day plan**, **My water**, **Crew** —
over two groups (Lake guide, Settings). Everything that answers "when should I
go?" lives on Today: the score for today, the next seven days, and the season's
best windows, which used to be three separate tabs a new user had to choose
between. **My water** is one view with three sub-tabs (map & waypoints, spots,
trips) rather than the separate Spots and Log tabs it grew from, and **Crew**
holds friends and messages together. Sharing is one form with a type chooser,
not three near-identical forms.

Copy leads with the answer and puts the mechanism second: "Moon overhead — fish
feed hardest" rather than "solunar major", "the wind has miles to build waves"
rather than "fetch".

## Electronics

The app used to assume Garmin and LiveScope throughout. Onboarding and Settings
→ Profile ask what the angler actually runs (`plotterBrand`, `ffsBrand`), and
the app follows: GPX export defaults to their plotter brand, the live-sonar view
is named for their unit (LiveScope / ActiveTarget / MEGA Live), and it drops out
of the nav entirely for anyone who doesn't run forward-facing sonar. Both fields
are nullable so "never asked" stays distinct from "none".

Colors come from ElavoAI's dashboard, not an approximation of it: `#29ABE2`
primary, `#1F96C8` hover, `#1882AE` deep accent, `#10233F` ink, `#DCE7F5`
border, and the soft-fill family it uses around accented elements — `#F0F9FF`
hover/active fill, `#E0F4FC` soft accent, `#C8E6F7` ring. Dark mode maps the
same roles onto translucent accents so the night palette still protects night
vision on the water.

## Chartplotter import / export

Waypoints move both ways as GPX 1.1. Import accepts an export from any unit:
points are matched on local tag names (so a `gpxx:`, `lowrance:` or `h:`
namespace prefix can't hide a field), route points come in alongside plain
waypoints, the icon is read from `<sym>` or `<type>` against a combined
Garmin/Lowrance/Humminbird vocabulary, and depth is picked up from whichever
vendor extension carries it. A binary Lowrance `.usr` or Humminbird `.hwr` is
detected and answered with "export GPX on the unit instead" rather than a parse
error.

Export asks which plotter you're loading: the `<sym>` vocabulary and the
on-screen "where to copy it" instructions change per vendor (Garmin's
`\Garmin\GPX\`, Lowrance's Files → Memory card → Import, Humminbird's Nav →
Waypoint Management → Import), and generic GPX omits `<sym>` entirely. The file
is named after the active lake.

## Adding a lake

Adding a lake stores a name and coordinates instantly, then enriches it in the
background from public sources — none of which need a key:

- **Water-level gauge** — the nearest USGS monitoring location that reports
  level, preferring a lake/reservoir site over a stream gauge (a stream gauge
  five miles upriver says nothing about pool elevation, so a distant one is
  refused rather than adopted). Discovery uses `api.waterdata.usgs.gov`; the
  older `waterservices.usgs.gov/nwis/site` service times out consistently and is
  part of the NWIS stack being retired, though the `iv` endpoint the app reads
  levels from still works.
- **Boat ramps** — OpenStreetMap via Overpass, cached 30 days per lake. OSM
  ramps are often unnamed (all four of Granbury's are) and often mapped twice,
  so unnamed ramps are labelled by distance and bearing from the lake centre and
  near-duplicates are collapsed — otherwise the picker is four identical rows.
- **The AI guide** — species with a twelve-month activity rating, seasonal
  notes, patterns, a regulations link and the lake's orientation.

Each step is independent, so one dead service leaves the lake thinner rather
than unusable.

## Species per lake

`FISH` is Granbury's hand-verified dataset. On any other water the species come
from that lake's AI guide — `species[]` with a twelve-month activity rating —
shaped to the same fields, so the dropdowns, the seasonal grid and the species
panel all work unchanged on Lake Michigan or anywhere else. A lake with no guide
yet falls back to a short common list rather than showing Granbury's crappie and
blue cats, and the species panel renders only the fields that exist (an AI
species has a note and a season, not Granbury's where/how/bait lists).

## Lake orientation

Wind advice tells you which bank the bait is stacking on, and how much fetch the
wind is building — the second half depends on which way the lake runs. That
orientation (`axisDeg`, a 0-179 bearing) comes from the lake profile when it has
one (Granbury is hand-verified at 135° — northwest-southeast — and the AI
profile prompt asks for it), otherwise from the OSM bounding box, which can only
tell north-south from east-west and only for a clearly elongated lake. When
neither knows, the app says nothing about fetch rather than assuming every lake
is shaped like Granbury.

## Finding anglers

`GET /api/users/search?q=` matches on display name, username, town and exact
email, and each angler controls whether they appear at all
(`discoverability`, on Settings → Profile):

| setting | who finds you |
| --- | --- |
| `everyone` | anyone signed in |
| `friends_of_friends` (default) | someone who shares an accepted friend with you |
| `nobody` | no one — you are not listed |

An exact email address reaches anyone regardless, including `nobody`: knowing
someone's address is its own introduction, and it's how the original invite flow
worked. Blocked pairs never see each other, you never see yourself, and each
result carries the existing relationship (`none` / `requested` / `incoming` /
`friend`) so the UI never offers to add someone twice. Requests can be sent by
user id from search results or by email as before.

## Blocking

An angler can block another from the Friends tab. A block replaces whatever
relationship existed and cuts both ways: the pair vanish from each other's lake
feed, friend lists, profiles, search and messages, existing conversations drop
out of the thread list (history stays in the database, just out of sight), and
friend requests between them are refused. Only the person who blocked can lift
it. Probing responses stay deliberately vague — a blocked profile is "not found"
and a refused message reads the same in both directions, so a block can't be
detected by poking at the API.

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

    ./scripts/test.sh        # throwaway Postgres, migrations, server suite + UI smoke
    ./scripts/smoke-ui.sh    # just the browser pass
    cd server && npm test    # unit tests only (integration suites skip)

`scripts/test.sh` starts a disposable `postgres:16`, applies the committed
migrations to it (so a broken migration fails the run), and executes the
`node:test` suites in `server/test`: magic-link sign-in and session lifecycle,
the visibility rules (private stays private, group records reach that group
only, you can't share into a group you don't belong to), blocking, onboarding,
and the changelog and lake-geometry pure functions.

It then runs `scripts/smoke-ui.sh`, which loads the real `public/index.html` in
headless Chrome once per view and checks the view opened, the sidebar rendered,
and nothing threw — the server suite never loads the app, so without this a
typo in the nav model ships silently and blanks the page for everyone. The app
stamps `data-js-error` on `<html>` from its own error handler, which is what the
smoke test reads. It skips cleanly when no Chrome is installed.

## The day planner

You choose the day (today through the end of the forecast), the hours you can
actually fish, whether you're in a boat or on the bank, what you're after,
whether you want numbers or one big fish, and where you're launching — a boat
ramp you've marked, any other mark, or a dropped pin. Fishing from shore or a
pier changes the plan, not just the wording: every stop has to be reachable on
foot. A cached plan whose inputs no longer match (different hours, off the bank
now, launching elsewhere) is regenerated rather than served. Given a launch point the
plan is ordered around it, with rough distances from the ramp. **Anything
biting** hands the species choice to the model, which picks the target and says
why. Plans are cached per lake + day + species + goal, and regenerate as the day
approaches and the forecast firms up.

### Recent reports (optional, off by default)

With `AI_WEB_SEARCH=1` (admin → Environment) the planner gets Anthropic's
server-side web search — up to four searches per plan — and is told how to weigh
what it finds, highest first:

1. official state agency reports, gauge and generation data
2. local guides, marinas and bait shops on **this** lake in the last two weeks
3. tournament and club results from this lake this season
4. angler forum and social posts — weak, unverified signal, never the sole basis

Recency beats authority on what's biting right now; authority beats recency on
regulations, safety and lake operations. Anything actually used comes back as
sources with dates and is shown under the plan. Searches are billed at $10 per
1,000 on top of tokens and are counted in admin → AI usage & cost, which is why
it is off unless you turn it on.

## Choosing the model

Each AI feature has its own model and an optional fallback, both dropdowns in
admin → Environment: **lake guide**, **day plan**, **catch photos**. The model
id picks the provider — `claude-*` goes to Anthropic, `gpt-*` and `o*` to
OpenAI (set `OPENAI_API_KEY`) — so switching provider is a dropdown, not a
deploy.

**The fallback fires on failure, not on taste.** A model that errors, times
out, gets truncated, or returns something the feature can't parse is
objectively unusable, and the request is retried on the fallback model. Judging
whether an answer is *good* would need a judge model on every call, which costs
more than a cheap model saves — so the caller supplies a validator (for plans
and guides: "does the JSON parse") and that decides. Both attempts are recorded
in the cost view, so a model that keeps failing over to its backup is visible
rather than merely expensive.

Measured cost of one real day plan (1,780 in / 791 out) and one lake guide
(386 in / 2,269 out) at current prices:

| model | day plan | lake guide | per 1,000 plans |
| --- | --- | --- | --- |
| claude-opus-5 | $0.0287 | $0.0587 | $28.70 |
| claude-sonnet-5 | $0.0115 | $0.0235 | $11.47 |
| claude-haiku-4-5 | $0.0057 | $0.0117 | $5.73 |
| gpt-5-mini | $0.0020 | $0.0046 | $2.03 |
| gpt-4o-mini | $0.0007 | $0.0014 | $0.70 |

## AI usage and cost

Every model call is recorded with its token counts and what it cost, priced at
call time from the rate table in `server/src/services/aiUsage.ts` — storing the
dollar figure rather than recomputing it means a later price change can't
rewrite last month's numbers. Admin → **AI usage & cost** breaks it down by
feature (day plans / lake guides / catch photos), by model, and by day, with a
7/30/90-day window and the most recent calls; System health carries the 30-day
total. A model with no rate on file is shown as *unpriced* rather than free, so
a zero is never mistaken for cheap.

## Client errors

The app reports its own JavaScript failures to `POST /api/client-error`
(anonymous allowed — the errors worth catching are the ones that break the page
before sign-in — rate-limited by IP, capped at five per page load). Admin →
**Client errors** groups them by message, and System health shows a 24-hour
count, so a bad deploy is visible to you rather than only to the angler whose
screen went blank. Rows older than 14 days are swept.

## Notes

- HTTPS is required for GPS ("Find me"), offline mode, and Secure cookies.
- After changing anything in `public/`, bump `CACHE` in `sw.js` (`elavofishai-v11`
  → `v12`) so installed copies refresh.
- The planner is account-gated: `/app` redirects anonymous visitors to `/login`.
- The USGS lake-level API is slated for decommissioning in early 2027; the app
  already has manual entry as a fallback.
