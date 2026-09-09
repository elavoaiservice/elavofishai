#!/bin/sh
# Run the server test suite against a throwaway Postgres.
#
#   ./scripts/test.sh
#
# Starts a disposable postgres:16 container, applies the real migrations to it
# (so a broken migration fails the build too), runs the suite, and removes the
# container on the way out. Without a database the integration suites skip and
# only the pure unit tests run — `cd server && npm test`.
set -e

NAME=elavofishai-test-db
PORT="${TEST_PG_PORT:-55433}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "[test] starting throwaway postgres on :$PORT"
docker run -d --rm --name "$NAME" \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=elavofish_test \
  -p "$PORT:5432" postgres:16 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM

i=0
until docker exec "$NAME" pg_isready -U test >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "[test] postgres never became ready" >&2; exit 1; }
  sleep 1
done

export DATABASE_URL="postgres://test:test@localhost:$PORT/elavofish_test"
export TEST_DATABASE_URL="$DATABASE_URL"
export DEV_SHOW_MAGIC_LINK=1
unset NODE_ENV

cd "$REPO_DIR/server"
echo "[test] applying migrations"
npx prisma migrate deploy
echo "[test] running suite"
npm test
