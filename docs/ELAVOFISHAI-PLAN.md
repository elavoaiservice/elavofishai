# ElavoFishAI — Build Plan

**What it is becoming:** a production-ready, multi-user, *social* fishing app under
the Elavo AI brand. Users sign in with a magic link, add **any public lake or body
of water** (search → the system adds it), get AI + community fishing intelligence for
it, log trips, and **share logs/spots/data with friends and friend-groups** to help
each other find fish. Rebranded from "Lake Granbury Fishing AI" → **ElavoFishAI**.

Origin: a single-lake (Lake Granbury, TX) single-file PWA with a zero-dependency
file-based backend. The fishing engine is excellent and is **kept**; the persistence,
auth, multi-lake, and social layers are **rebuilt** on a real stack.

---

## Locked decisions (2026-09-09)

1. **Stack — Evolve, don't rewrite.** Keep the single-file HTML/JS/PWA frontend and
   its fishing engine. Replace the file-KV `server.js` with a real backend +
   Postgres. (Not a Next.js rewrite — that reimplements 3,270 lines of working
   fishing logic for no near-term gain. The app's palette already matches ElavoAI.)
2. **Magic-link auth — dev/console mode first.** Build passwordless email magic-link
   sign-in + self-registration; in dev the link is surfaced in the admin panel / logs
   (no email dependency on the LAN). Swap in a real email provider before public.
3. **Multi-lake intelligence — AI layered over community.** Generic engine runs on
   any lake from coordinates. On add, **Claude generates a starter lake profile**
   (species / seasonal calendar / patterns / regs link), cached per lake. **Trust
   hierarchy, highest wins:** real-time computed → AI starter → your logged data →
   friends' shared data. **Granbury is kept as a hand-verified profile** the AI never
   overwrites.
4. **Milestone — Foundation first.** Ship a usable, deployed ElavoFishAI on the Mini
   (rebrand, logo, DB, magic-link signup, add-any-lake), then layer social, then
   admin. **Full schema is designed up front** so phases don't rework the DB.

---

## Target architecture

- **Frontend:** the existing single-file PWA (`lake-granbury-planner.html` → renamed).
  Keep the engine (solunar, weather, water-temp, scoring, Leaflet map, trip log,
  CSV/GPX). **Generalize** the hard-coded Granbury constants (LAT/LON, USGS gauge,
  full pool, default spots/waypoints, map center, species/seasonal prose) into
  **per-lake data loaded from the backend**. Add screens: lake search/switcher,
  friends, sharing settings, profile, admin.
- **Backend (new):** **TypeScript + Fastify + Prisma + Postgres**, Node 22. Serves the
  static app **and** `/api/*` same-origin (session cookie is SameSite). Real
  migrations, typed models — aligns with ElavoAI's TS/Prisma world.
- **AI:** server-side Anthropic SDK (Claude) for lake-profile generation, cached in
  `lake_profiles`. Default `claude-opus-4-8`; `claude-sonnet-5` is the cheap option
  for bulk profiles.
- **Deploy:** Docker Compose (Postgres + app) on the Mac Mini, **its own port
  (app :3100)** so it runs alongside AlphaGasIQ (web :3000 / api :8000). Same
  git-pull → rebuild → restart pattern as AlphaGasIQ (Mini needs a read-only deploy
  key on this repo). Lake search uses free **OpenStreetMap Nominatim** + **USGS** for
  gauges — no paid API key.
- **External data (all free, no key):** Open-Meteo (weather), USGS Water Services
  (lake level / gauges), OSM Nominatim (lake search).

---

## Data model (Postgres / Prisma — designed in full now)

**Identity & auth**
- `User` — id, email (unique), displayName, username (unique), avatarUrl, isAdmin,
  status (active/suspended), createdAt.
- `AuthToken` — magic links: id, email, tokenHash, purpose (login|signup),
  expiresAt, usedAt, ip. (Dev mode exposes the link to admin.)
- `Session` — id, userId, tokenHash, expiresAt, ip, userAgent.
- `RateLimit` — keyed attempts (magic-link requests / IP) with a bounded table.

**Lakes & intelligence** (lakes are global/shared, deduped — one row per real lake)
- `Lake` — id, name, region/state, country, lat, lon, gaugeId, gaugeSource
  (usgs|manual|none), fullPool, bbox, osmRef, addedByUserId, createdAt.
- `LakeProfile` — lakeId (unique), content (JSON: species[], seasonalCalendar,
  patterns, regsUrl), source (ai|hand_verified|community), model, generatedAt,
  verified. **Granbury seeded as `hand_verified`.**
- `UserLake` — a user's saved lakes: userId, lakeId, isHome, addedAt.

**Fishing data** (shareable → normalized so friends can query it)
- `Trip` — id, userId, lakeId, date, species, weight, length, lure, lat, lon,
  spotId?, notes, weatherJson, visibility (private|friends|group|public), createdAt.
- `Spot` — id, userId, lakeId, name, lat, lon, notes, visibility.
- `Waypoint` — id, userId, lakeId, name, lat, lon, kind, visibility.
- `Kv` — private misc the frontend already uses (theme, checklist, drive-time…):
  (userId, lakeId?, key, value). Preserves the app's `stGet/stSet` seam.

**Social**
- `Friendship` — userId, friendId, status (pending|accepted|blocked), requestedBy,
  createdAt. (Undirected once accepted.)
- `FriendGroup` — id, ownerUserId, name.
- `FriendGroupMember` — groupId, memberUserId.
- `SharingPref` — per-user default per data type: userId, dataType (trips|spots|
  waypoints), scope (none|friends|groups|public), groupIds[]. Per-record
  `visibility` overrides the default.

**Ops**
- `AuditLog` — admin actions.
- `ProfileContribution` — community corrections to a `LakeProfile` (Phase 3).

**Sharing resolution:** a viewer sees a record when it's theirs, OR visibility=public,
OR visibility=friends and they're accepted friends, OR visibility=group and they're in
that group. Friends' shared trips/spots surface in a per-lake "friends' activity" feed
and on the map.

---

## API surface (same-origin `/api/*`, `Cache-Control: no-store`)

- **Auth:** `POST /api/auth/request-link {email}` (login+signup unified),
  `GET /api/auth/verify?token`, `POST /api/auth/logout`, `GET /api/me`.
- **Lakes:** `GET /api/lakes/search?q` (OSM+DB), `POST /api/lakes` (add + dedupe +
  trigger profile), `GET /api/lakes/:id`, `GET/POST /api/me/lakes`, set home,
  `POST /api/lakes/:id/profile/regenerate`.
- **Data (per lake):** `GET/POST/PUT/DELETE /api/lakes/:id/trips|spots|waypoints`,
  `GET /api/lakes/:id/feed` (friends' shared), `GET/PUT /api/kv/:key` (private misc,
  keeps the existing contract).
- **Social:** `GET /api/friends`, `POST /api/friends/request`,
  `POST /api/friends/:id/accept`, `DELETE`; `CRUD /api/groups` + membership;
  `GET/PUT /api/me/sharing`.
- **Admin:** `GET /api/admin/users` + suspend/promote, `GET /api/admin/lakes` +
  regenerate/verify profiles, `GET /api/admin/magic-links` (dev), stats.

The original 6-route KV contract (`INTEGRATION.md` / `contract-test.js`) stays
satisfied for the private-misc keys so the engine keeps working during the migration.

---

## Branding & logo

- **Rename** everywhere: title, `<h1>`, manifest, `apple-mobile-web-app-title`,
  GPX/CSV creators, filenames → **ElavoFishAI**. Keep Granbury copy only inside the
  Granbury lake profile.
- **Logo:** replace the Texas silhouette with a **US map** + the jumping fish; keep
  the blue-on-navy ElavoAI palette. Regenerate favicon + `icon-192/512` +
  `apple-touch-icon`.
- **Look & feel:** already ElavoAI (`#29ABE2`/`#1F96C8`/`#10233F`/Inter). Light-touch:
  logo SVG + a scatter of `rgba(41,171,226)` literals + theme-color metas.

---

## Phases

**Phase 0 — Scaffold**
- New TS/Fastify/Prisma/Postgres backend; Docker Compose; full Prisma schema +
  first migration; config/env; serve the static app same-origin.
- Rebrand shell + US-map-fish logo/icons.

**Phase 1 — Core usable app → deploy to Mini** (first thing you can touch)
- Magic-link auth (dev/console) + self-registration + sessions.
- Multi-lake: generalize the frontend to per-lake config; lake search (OSM) + add;
  "my lakes" + home lake; **Granbury seeded hand-verified**.
- Migrate KV persistence to Postgres (per-user, per-lake); contract-test green.
- AI lake-profile generation (Claude), cached.
- **AI day planner** — pick a **day + lake + target species** → Claude produces an
  hour-by-hour plan (where/when/what to throw) grounded in the engine's live
  conditions (solunar, weather forecast, water temp, best hours) + the lake profile +
  friends' recent shared logs. **Re-generates as the day approaches** and the weather
  forecast firms up (forecasts sharpen inside ~7 days); cached per (lake, day,
  species) with a freshness stamp so opening it closer to the day gives a sharper plan.
- **Public marketing landing page** — ElavoAI look & feel (hero + all features +
  CTAs), the front door to the app. Anonymous → landing; sign in → the planner.
- Deploy on the Mini, own port; deploy key + upgrade flow.

**Phase 2 — Private-first sharing (the headline differentiator)**
> Competitive wedge: anglers hide spots, so Fishbrain's *public* feed fights their
> instinct. ElavoFishAI's trusted-circle model — share real spots/logs only with
> friends/groups you choose — is the thing the big data-network apps can't easily copy.
> (Market read 2026: Fishbrain ~14M users but public + paywalled; BassIQ does AI
> condition→bait but no social; nobody owns trusted private sharing.)
- Friends (request/accept) + friend groups.
- Shareable trips/spots/waypoints (normalized) + **granular per-record visibility
  (private → friends → group)** + per-user sharing defaults — private by default.
- Per-lake "friends' activity" feed + friends' shared spots on the map: *friends
  help friends find fish*.

**Phase 3 — Admin Command Center + production**
Full admin portal modeled on ElavoAI's Command Center. Reuses the patterns already
built for AlphaGasIQ (config GUI + git-upgrade + RBAC):
- **Admin auth (separate from user magic-link):** a dedicated **`/admin`** login with
  **username + password + email MFA** (a one-time code emailed on login) — like
  ElavoAI's admin login. Distinct from the passwordless magic-link users get. Gated to
  admin-role accounts.
- **Metrics dashboard**: total users, active users (logged in — daily/weekly/monthly),
  new signups over time, total lakes added, total trips/logs, spots/waypoints,
  AI profiles generated, day plans generated; simple charts/sparklines.
- **User management**: list/search users, roles (user/pro/guide/admin), suspend/
  reactivate, promote to pro/guide/admin, view a user's lakes/log counts.
- **Settings GUI (.env in the browser)**: enter/edit runtime config with a Test
  button per setting + a Reload — Resend/email keys, ANTHROPIC_API_KEY + model,
  PUBLIC_BASE_URL, cookie/secure flags, etc. Secrets encrypted at rest (Fernet-style,
  like AlphaGasIQ's config_store); DB overlay → process.env → in-process reload.
- **Upgrade from Git**: trigger a host-side git pull + rebuild + restart with a live
  log (same safe launchd-watcher pattern as AlphaGasIQ; API writes a trigger file,
  never touches Docker/git directly).
- **Lakes/profiles**: list lakes, regenerate/verify AI profiles, mark hand-verified.
- **Magic-link viewer** (dev), audit log, content moderation hooks.
- Real email provider for magic links (replace dev/console).
- Community profile corrections; PWA/offline refresh; rate-limits, backups, and
  (optional) public exposure via Cloudflare Tunnel.

> The metrics dashboard + Settings GUI + Upgrade-from-Git are the user's explicit
> "full detailed admin portal like ElavoAI Command Center" ask (2026-09-09).

**Phase 4 — Monetization (future; design the hooks now)**
- **Pro/Guide accounts + data marketplace.** Verified pros/guides publish premium
  data (spots, patterns, seasonal intel, trip logs, custom lake profiles) for sale;
  buyers purchase → an **entitlement** grants access. This is a new tier above the
  social `visibility` scale (private → friends → group → public → **paid/marketplace**).
  Creates a revenue stream for pros; ElavoFishAI takes a platform fee.
- **Subscriptions.** Eventually a monthly app fee (free tier + paid tier gating
  premium features / marketplace access).
- **Payments — Stripe** (same rail as ElavoAI): **Stripe Billing** for the monthly
  subscription; **Stripe Connect** for marketplace payouts to pros (platform keeps a
  cut). Entitlements gate premium content server-side.

**Design-now hooks so Phase 4 is purely additive (no reshaping):**
- `User.role` reserved values `user | pro | guide | admin` (start everyone `user`);
  optional `ProProfile` (bio, verification, payout account) added later.
- `Trip/Spot/Waypoint.visibility` enum reserves a `paid`/`marketplace` value now.
- Reserve (don't build) future tables: `Listing`/`Product`, `Purchase`/`Entitlement`,
  `Payout`, `Subscription`/`Plan`. Because the schema is designed up front, these land
  as additive migrations.

---

## Hardening pass (2026-09-09) — done

Five items taken off the list before any wider exposure:

1. **Dev magic links can no longer be handed to strangers.** `DEV_SHOW_MAGIC_LINK`
   defaults to `0`, a production build refuses to boot with it on unless
   `ALLOW_INSECURE_DEV_LOGIN=1`, and the link is only ever returned to a caller on
   a private network. Resend is the intended path.
2. **Real migrations.** `prisma/migrations/` is committed and the container runs
   `migrate deploy`, not `db push --accept-data-loss`. A database from the push
   era is baselined against `0001_init` automatically. `scripts/backup.sh` does
   nightly gzipped dumps with retention.
3. **Upgrade-from-Git is live**: compose mounts `./deploy`, and
   `scripts/upgrade-agent.sh` (+ a launchd plist) is the host watcher that pulls,
   rebuilds, restarts and health-checks.
4. **Sharing finished**: `SharingPref` is wired end to end (`GET/PUT /api/me/sharing`
   + a Sharing defaults card), and waypoints are first-class shareable records
   like spots and catches — create, list, delete, feed, per-record visibility.
5. **Tests**: `node:test` suites over sign-in/session lifecycle and the whole
   visibility scale, run against a throwaway Postgres by `scripts/test.sh`.

**Changelog tab (2026-09-09).** Ported from ElavoAI: `/api/admin/changelog` +
an admin tab showing every update/fix/change behind the running build —
conventional-commit classification, search (subject/body/scope/sha/files),
day-grouped in Central Time, with "not deployed" rows for commits that are
pushed but not yet live. History is baked into the image at build time since
the container has no `.git`.

## Open items for later
- AI model for profiles: Opus (default) vs Sonnet (cheaper at bulk).
- Public exposure (Cloudflare Tunnel) vs LAN-only — LAN-only to start, like AlphaGasIQ.
- Whether to generalize Granbury's wind→bank logic (lake-orientation aware) for all lakes.
- Admin: lake-profile regenerate/verify actions, magic-link viewer, community
  profile corrections (`ProfileContribution`), moderation hooks.
- Phase 4 monetization (Stripe Billing + Connect) — hooks reserved, nothing built.
