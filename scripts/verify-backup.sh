#!/bin/sh
# Prove a backup is restorable — the only thing that makes a backup a backup.
#
#   ./scripts/verify-backup.sh [dump.sql.gz]
#
# Restores the dump into a throwaway postgres:16 container (never the live
# database), counts the rows that matter, and tears the container down. With no
# argument it takes the newest file in backups/.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DUMP="${1:-$(ls -t "$REPO_DIR"/backups/elavofish-*.sql.gz 2>/dev/null | head -1)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "[verify] no dump found — pass one, or run ./scripts/backup.sh first" >&2; exit 1; }

NAME=elavofishai-restore-check
PORT="${VERIFY_PG_PORT:-55436}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "[verify] restoring $(basename "$DUMP") into a throwaway postgres"
docker run -d --rm --name "$NAME" \
  -e POSTGRES_USER=elavofish -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=elavofish \
  -p "$PORT:5432" postgres:16 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM

i=0
until docker exec "$NAME" pg_isready -U elavofish >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "[verify] postgres never became ready" >&2; exit 1; }
  sleep 1
done

gunzip -c "$DUMP" | docker exec -i "$NAME" psql -q -U elavofish -d elavofish >/dev/null 2>&1 || {
  echo "[verify] FAILED: psql could not replay the dump" >&2; exit 1; }

echo "[verify] restored — row counts:"
docker exec "$NAME" psql -U elavofish -d elavofish -tAc \
  'SELECT concat_ws('\'' | '\'',
     concat('\''users='\'', (SELECT count(*) FROM "User")),
     concat('\''lakes='\'', (SELECT count(*) FROM "Lake")),
     concat('\''trips='\'', (SELECT count(*) FROM "Trip")),
     concat('\''spots='\'', (SELECT count(*) FROM "Spot")),
     concat('\''messages='\'', (SELECT count(*) FROM "Message")))' | sed 's/^/  /'

# A dump that restores but has no schema is not a backup.
TABLES=$(docker exec "$NAME" psql -U elavofish -d elavofish -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[ "$TABLES" -ge 20 ] || { echo "[verify] FAILED: only $TABLES tables restored" >&2; exit 1; }
echo "[verify] OK — $TABLES tables restored from $(basename "$DUMP")"
