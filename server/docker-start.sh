#!/bin/sh
# Container entrypoint: sync the schema, then start the server (which seeds Granbury).
# Prototype uses `prisma db push` (no migration history yet); switch to
# `prisma migrate deploy` once migrations are committed.
set -e
echo "[start] prisma db push..."
npx prisma db push --skip-generate --accept-data-loss
echo "[start] launching ElavoFishAI..."
exec node dist/index.js
