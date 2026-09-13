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

# launchd hands a job almost no PATH, and this script ran fine by hand and then
# could not find `docker` from a plain ssh shell. Same lesson as the watchdog:
# put the usual places back rather than depending on how it was invoked.
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

DEST="${1:-$(dirname "$0")/../backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
OUT="$DEST/elavofish-$STAMP.sql.gz"

# Left behind by a dump that died mid-stream. The prune below only matches
# finished files, so these sat there for good.
find "$DEST" -name 'elavofish-*.sql.gz.part' -mmin +120 -print -delete 2>/dev/null || true

echo "[backup] $(date -Iseconds) → $OUT"
# --clean --if-exists so the dump can be replayed over an existing database.
# Without pipefail the status of this line is gzip's, and gzip will happily
# compress the half a dump pg_dump managed before it died.
set -o pipefail 2>/dev/null || true
docker compose exec -T postgres pg_dump -U elavofish --clean --if-exists elavofish | gzip > "$OUT.part"
mv "$OUT.part" "$OUT"

# A dump that is suspiciously small means pg_dump failed mid-stream.
SIZE=$(wc -c < "$OUT")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] FAILED: dump is only ${SIZE} bytes" >&2
  exit 1
fi
# A kilobyte floor catches a dump that died immediately. It does not catch one
# that died half way, which on a months-old database is still megabytes — so
# compare with the last good backup and refuse anything under half of it.
PREV="$(ls -1t "$DEST"/elavofish-*.sql.gz 2>/dev/null | sed -n 2p)"
if [ -n "$PREV" ]; then
  PREV_SIZE=$(wc -c < "$PREV")
  if [ "$PREV_SIZE" -gt 0 ] && [ "$((SIZE * 2))" -lt "$PREV_SIZE" ]; then
    echo "[backup] FAILED: ${SIZE} bytes is less than half of the previous backup (${PREV_SIZE}) — not calling this good" >&2
    mv "$OUT" "$OUT.suspect"
    exit 1
  fi
fi

find "$DEST" -name 'elavofish-*.sql.gz' -mtime "+$KEEP_DAYS" -print -delete
echo "[backup] ok (${SIZE} bytes), kept ${KEEP_DAYS} days"

# Tell the app a backup happened. The dumps live on the host and the container
# cannot see them, so without this the admin page would say "no backup found"
# every day of its life — and a warning that is always wrong is worse than no
# warning at all. /deploy is the volume both sides already share.
STATUS_DIR="${DEPLOY_DIR:-$HOME/efa-deploy}"

# Offsite copy. A backup that lives on the machine it is backing up survives
# nothing worth surviving — a dead disk takes both. Uploaded through the app
# container, which holds the credentials and the signing code.
# 0 = in the bucket, 3 = there is no bucket configured, anything else = tried
# and failed. Only the first one is allowed to call itself offsite.
OFFSITE=true
set +e
docker compose exec -T app node tools/upload-backup.js "$(basename "$OUT")" < "$OUT"
UP=$?
set -e
if [ "$UP" -eq 3 ]; then
  OFFSITE=false
  echo "[backup] NOTE: no object storage configured — this dump exists only on this machine"
elif [ "$UP" -ne 0 ]; then
  OFFSITE=false
  echo "[backup] WARNING: offsite copy failed — the local dump is still good"
fi

# Written last, and now recording whether the copy actually left the building.
# An offsite step that fails every night in silence is the same as not having
# one, and the dashboard had no way to know.
if [ -d "$STATUS_DIR" ]; then
  printf '{"at":"%s","bytes":%s,"name":"%s","offsite":%s}\n' \
    "$(date -Iseconds)" "$SIZE" "$(basename "$OUT")" "$OFFSITE" > "$STATUS_DIR/backup-status.json"
fi
