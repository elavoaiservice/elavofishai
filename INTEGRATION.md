# Lake Granbury Fishing AI — backend integration brief

You are working inside the ElavoAI codebase. Integrate the API for a small
companion app (a fishing planner) into this stack. The frontend is a finished
single-file app that talks to exactly six routes — implement those routes using
THIS codebase's existing conventions (framework, auth style, database client,
deployment target). Do not invent a parallel stack.

## The contract (six routes, same-origin)

1. `GET /api/me`
   → `200 {"user": "<username>"|null, "inviteRequired": <boolean>}`
   Never errors for anonymous users.

2. `POST /api/register`  body `{"username","password","invite"?}`
   - username: `/^[a-zA-Z0-9_.-]{3,24}$/` → else 400
   - password: min 8 chars → else 400
   - duplicate username → 409
   - if registration is gated, wrong/missing invite → 403
   - success → `200 {"user"}` + session cookie (HttpOnly, SameSite=Lax,
     Secure in production)

3. `POST /api/login`  body `{"username","password"}`
   - wrong credentials → `401 {"error"}` (same message for bad user vs bad
     password — don't leak which)
   - success → `200 {"user"}` + session cookie

4. `POST /api/logout` → 200, session invalidated server-side, cookie cleared.

5. `GET /api/kv/:key` (key is URL-encoded, e.g. `granbury%3Atrips`)
   - no session → 401
   - key never written → **404** (the frontend depends on 404 meaning
     "no data yet")
   - else → `200 {"value": "<exact string previously stored>"}`

6. `PUT /api/kv/:key`  body = the RAW value string (not JSON-wrapped)
   - no session → 401
   - store per-user, byte-identical round-trip, up to 2 MB per key
   - → `200 {"ok": true}`
   - Validate key: `/^[\w:.-]{1,80}$/` → else 400

## Data model

Per-user key-value pairs. If this codebase uses SQL, a sufficient table:

    CREATE TABLE granbury_kv (
      user_id  <same type as the users table PK>,
      k        TEXT,
      v        TEXT,
      updated  TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, k)
    );

Keep it in its own table/schema — do not mix with existing product tables.

## Auth: two acceptable modes (ask the owner which)

A. **Shared logins**: skip register/login/logout bodies above; instead have
   `/api/me` and the kv routes validate the EXISTING ElavoAI session, and
   return the existing account's display name as `user`. Registration then
   happens through the normal ElavoAI flow. `inviteRequired` → false.

B. **Separate accounts**: implement register/login as specified, storing
   fishing-app users in their own table, hashed with the same password
   library this codebase already uses (bcrypt/argon2/scrypt — match
   what exists).

## Hard requirements

- Same-origin: the app HTML must be served by the same host that answers
  `/api/*` (session cookie is SameSite). Add a route/static mount that serves
  the provided files: `lake-granbury-planner.html`, `sw.js`,
  `manifest.webmanifest`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`.
- `Cache-Control: no-store` on all `/api/*` responses.
- Rate-limit login attempts (any reasonable strategy; 10 fails / 10 min / IP
  is the reference behavior). Do not let the table of attempts grow forever.
- Cap per-user storage. The app needs about a dozen keys; the reference server
  allows 64 keys, 2 MB each, 8 MB per account, so one login cannot fill a disk.
- A PUT is read-modify-write over one user's data. Serialize it per user (or
  use a real upsert) so two saves at once cannot lose one.
- Never serve the storage/data location as static files.

## Acceptance

Run the provided contract test against the dev server:

    BASE_URL=http://localhost:<port> node contract-test.js

The test registers its own users, so run the dev server with registration open
while testing.

Done means: **CONTRACT SATISFIED** with zero FAIL lines (WARN lines are
recommendations). Then open the app in a browser, create a user, log a trip,
reload — the trip must survive, and a second user must not see it.
