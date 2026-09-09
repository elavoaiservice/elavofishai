#!/bin/sh
# ElavoFishAI upgrade agent — the host side of the admin "Upgrade from Git" button.
#
# The app container never runs git or docker itself. It only writes a trigger
# file into the shared ./deploy directory (mounted as /deploy). This agent runs
# on the host, watches for that file, and does the actual pull + rebuild +
# restart, streaming progress to deploy/status.log — which the admin panel tails.
#
#   ./scripts/upgrade-agent.sh          # watch forever (INTERVAL=10s)
#   ./scripts/upgrade-agent.sh --once   # run one upgrade now, then exit
#
# Install it on the Mini with the launchd plist beside this script, or run it
# under tmux/systemd. It must run as a user who can push/pull the repo and talk
# to Docker.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy"
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
      return 0
    fi
    i=$((i + 2))
    sleep 2
  done
  log "WARNING: rebuilt to $after but /health/ready did not answer within 120s"
  return 1
}

if [ "$1" = "--once" ]; then
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
