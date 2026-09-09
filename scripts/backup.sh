#!/bin/sh
# Nightly Postgres backup for ElavoFishAI.
#
#   ./scripts/backup.sh [destination-dir]
#
# Dumps the database out of the running compose stack to a gzipped file and
# prunes anything older than KEEP_DAYS. Run it from the repo root — on the Mini,
# from cron or a launchd timer:
#
#   0 3 * * *  cd /path/to/elavofishai && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# Restore:  gunzip -c backups/elavofish-<stamp>.sql.gz | \
#             docker compose exec -T postgres psql -U elavofish elavofish
#
# Verify a dump without touching the live database (recommended after any
# change to this script):  ./scripts/verify-backup.sh backups/<file>.sql.gz
set -e

DEST="${1:-$(dirname "$0")/../backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
OUT="$DEST/elavofish-$STAMP.sql.gz"

echo "[backup] $(date -Iseconds) → $OUT"
# --clean --if-exists so the dump can be replayed over an existing database.
docker compose exec -T postgres pg_dump -U elavofish --clean --if-exists elavofish | gzip > "$OUT.part"
mv "$OUT.part" "$OUT"

# A dump that is suspiciously small means pg_dump failed mid-stream.
SIZE=$(wc -c < "$OUT")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] FAILED: dump is only ${SIZE} bytes" >&2
  exit 1
fi

find "$DEST" -name 'elavofish-*.sql.gz' -mtime "+$KEEP_DAYS" -print -delete
echo "[backup] ok (${SIZE} bytes), kept ${KEEP_DAYS} days"
