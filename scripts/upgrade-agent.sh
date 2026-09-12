#!/bin/sh
# ElavoFishAI upgrade agent — the host side of the admin "Upgrade from Git" button.
#
# The app container never runs git or docker itself. It only writes a trigger
# file into the shared ./deploy directory (mounted as /deploy). This agent runs
# on the host, watches for that file, and does the actual pull + rebuild +
# restart, streaming progress to deploy/status.log — which the admin panel tails.
#
#   ./scripts/upgrade-agent.sh --once   # act on a pending trigger, then exit
#   ./scripts/upgrade-agent.sh          # poll for triggers (INTERVAL=10s)
#
# --once is the mode to install: the launchd plist beside this script uses
# WatchPaths, so macOS runs it the moment the trigger file appears — no polling
# loop to keep alive. The watch loop is the fallback for systemd/tmux hosts.
# It must run as a user who can pull the repo and talk to Docker.
#
# DEPLOY_DIR overrides where the trigger/lock/log live (must match the host path
# compose mounts at /deploy); it is read from the repo's .env when set there.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Keep in step with docker-compose.yml, which mounts ${DEPLOY_DIR:-./deploy}.
if [ -z "$DEPLOY_DIR" ] && [ -f "$REPO_DIR/.env" ]; then
  DEPLOY_DIR="$(sed -n 's/^DEPLOY_DIR=//p' "$REPO_DIR/.env" | tail -1)"
fi
DEPLOY_DIR="${DEPLOY_DIR:-$REPO_DIR/deploy}"
TRIGGER="$DEPLOY_DIR/trigger"
LOCK="$DEPLOY_DIR/upgrade.lock"
LOG="$DEPLOY_DIR/status.log"
INTERVAL="${INTERVAL:-10}"
BRANCH="${UPGRADE_BRANCH:-main}"

mkdir -p "$DEPLOY_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

run_upgrade() {
  # Claim the run: drop the trigger first so a request that lands mid-upgrade
  # queues a fresh run instead of being swallowed by this one.
  rm -f "$TRIGGER"
  : > "$LOG"
  touch "$LOCK"
  # Always clear the lock, however this run ends — a stuck lock disables the
  # button until someone deletes it by hand.
  trap 'rm -f "$LOCK"' EXIT INT TERM

  log "upgrade requested — branch $BRANCH"
  cd "$REPO_DIR"

  before="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  log "current commit: $before"

  if ! git fetch --quiet origin "$BRANCH" >>"$LOG" 2>&1; then
    log "FAILED: could not fetch origin/$BRANCH"
    return 1
  fi
  # Fast-forward only: local edits on the Mini stop the deploy rather than being
  # silently merged or clobbered.
  if ! git merge --ff-only "origin/$BRANCH" >>"$LOG" 2>&1; then
    log "FAILED: cannot fast-forward to origin/$BRANCH (local changes on the host?)"
    return 1
  fi

  after="$(git rev-parse --short HEAD)"
  if [ "$before" = "$after" ]; then
    log "already at $after — rebuilding anyway to pick up config changes"
  else
    log "updated $before → $after"
    git --no-pager log --oneline "$before..$after" >>"$LOG" 2>&1 || true
  fi

  # compose interpolates these from .env when run from the project directory;
  # exporting PG_PASSWORD too keeps a launchd environment (no shell profile)
  # from silently building with the default password.
  if [ -f "$REPO_DIR/.env" ]; then
    PG_PASSWORD="$(sed -n 's/^PG_PASSWORD=//p' "$REPO_DIR/.env" | tail -1)"
    export PG_PASSWORD
  fi

  log "building images..."
  if ! docker compose build >>"$LOG" 2>&1; then
    log "FAILED: docker compose build"
    return 1
  fi

  log "restarting stack..."
  if ! docker compose up -d >>"$LOG" 2>&1; then
    log "FAILED: docker compose up"
    return 1
  fi

  log "waiting for the app to come back..."
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS "http://localhost:${PORT:-3100}/health/ready" >/dev/null 2>&1; then
      log "DONE — now running $after"
      # Only now is the old image safe to throw away. Pruning before the health
      # check discarded the one thing that could undo a bad deploy.
      docker image prune -f >/dev/null 2>&1 || true
      return 0
    fi
    i=$((i + 2))
    sleep 2
  done

  # It built, it started, and it never answered. Leaving it there means the site
  # is down until somebody notices; going back to the commit that was serving
  # traffic five minutes ago means it is not.
  log "FAILED: $after did not answer /health/ready within 120s — rolling back to $before"
  if git reset --hard "$before" >>"$LOG" 2>&1 && docker compose build >>"$LOG" 2>&1 && docker compose up -d >>"$LOG" 2>&1; then
    i=0
    while [ "$i" -lt 60 ]; do
      if curl -fsS "http://localhost:${PORT:-3100}/health/ready" >/dev/null 2>&1; then
        log "ROLLED BACK to $before — the site is answering again"
        return 1
      fi
      i=$((i + 2))
      sleep 2
    done
    log "ROLLBACK FAILED: $before did not answer either — this needs hands"
  else
    log "ROLLBACK FAILED: could not rebuild $before — this needs hands"
  fi
  return 1
}

if [ "$1" = "--once" ]; then
  # Nothing pending (launchd also fires on trigger deletion) — not an error.
  [ -f "$TRIGGER" ] || { echo "[upgrade-agent] no trigger pending"; exit 0; }
  [ -f "$LOCK" ] && { echo "[upgrade-agent] an upgrade is already running"; exit 0; }
  run_upgrade
  exit $?
fi

echo "[upgrade-agent] watching $TRIGGER every ${INTERVAL}s (branch $BRANCH)"
while true; do
  if [ -f "$TRIGGER" ]; then
    # Subshell: a failed run must not kill the watcher (set -e) or leak its trap.
    (run_upgrade) || echo "[upgrade-agent] upgrade failed — see $LOG"
  fi
  sleep "$INTERVAL"
done
