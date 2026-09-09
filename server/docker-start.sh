#!/bin/sh
# Container entrypoint: bring the schema up to date, then start the server
# (which seeds Granbury).
#
# Schema changes go through real migrations — `prisma db push` was dropped
# because it silently reshapes tables and can drop columns holding real data.
# A database created by the old push path has no migration history, so it is
# baselined once against 0001_init before any migration runs.
set -e

case "$(node prisma/baseline.js)" in
  baseline)
    echo "[start] existing schema with no migration history — baselining 0001_init"
    npx prisma migrate resolve --applied 0001_init
    ;;
esac

echo "[start] prisma migrate deploy..."
npx prisma migrate deploy

echo "[start] launching ElavoFishAI..."
exec node dist/index.js
