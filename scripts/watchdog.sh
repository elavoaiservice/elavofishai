#!/bin/sh
# Is the app actually answering?
#
#   ./scripts/watchdog.sh            # one check
#   launchd runs it every two minutes — see com.elavofishai.watchdog.plist
#
# Three things, in order of how much they help:
#
#   1. Ask /health/ready. Two consecutive failures is a real outage, not a
#      blip during a deploy.
#   2. Restart the app container once. Most outages here are a wedged process,
#      and a restart fixes those before anyone notices.
#   3. If it is still down after that, say so out loud — email, and a line in
#      the log the admin page reads.
#
# The alert credentials live in this script's own environment, NOT in the app's
# configuration. An alerting channel that stops working when the thing it
# watches stops working is not an alerting channel: the app's Resend key is
# encrypted in the database and only the app can read it, which is no use at
# the exact moment the app is the problem.
#
# Set in the plist (or the shell) to turn alerting on:
#   ALERT_RESEND_KEY   a Resend API key
#   ALERT_EMAIL_TO     where to send
#   ALERT_EMAIL_FROM   a verified sender
# Without them the watchdog still restarts and still logs; it just cannot tell
# anyone, and says as much.
set -e

URL="${HEALTH_URL:-http://localhost:3100/health/ready}"
DIR="${REPO_DIR:-$HOME/elavofishai}"
STATE="${STATE_DIR:-$HOME/efa-deploy}"
LOG="$STATE/watchdog.log"
FAILS="$STATE/watchdog.fails"
DOWN="$STATE/watchdog.down"

mkdir -p "$STATE"
log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

alert() {
  subject="$1"; body="$2"
  log "ALERT: $subject"
  [ -n "$ALERT_RESEND_KEY" ] && [ -n "$ALERT_EMAIL_TO" ] || { log "  (no ALERT_RESEND_KEY/ALERT_EMAIL_TO — nobody was told)"; return 0; }
  curl -sS -m 20 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $ALERT_RESEND_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"from\":\"${ALERT_EMAIL_FROM:-alerts@elavoai.com}\",\"to\":[\"$ALERT_EMAIL_TO\"],\"subject\":\"$subject\",\"text\":\"$body\"}" \
    >> "$LOG" 2>&1 || log "  (the alert email itself failed to send)"
}

if curl -fsS -m 10 "$URL" >/dev/null 2>&1; then
  # Back up after being down: say so, so nobody goes looking for a dead site.
  if [ -f "$DOWN" ]; then
    since="$(cat "$DOWN" 2>/dev/null || echo unknown)"
    log "recovered (was down since $since)"
    alert "ElavoFishAI is back up" "The site started answering again at $(date -Iseconds). It had been down since $since."
    rm -f "$DOWN"
  fi
  rm -f "$FAILS"
  exit 0
fi

COUNT=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$FAILS"
log "health check failed ($COUNT in a row)"

# One failure can be a deploy restarting; two in a row is an outage.
[ "$COUNT" -lt 2 ] && exit 0

if [ ! -f "$DOWN" ]; then
  date -Iseconds > "$DOWN"
  log "restarting the app container"
  (cd "$DIR" && docker compose restart app >> "$LOG" 2>&1) || log "  (restart command failed)"
  sleep 20
  if curl -fsS -m 10 "$URL" >/dev/null 2>&1; then
    log "recovered after a restart"
    alert "ElavoFishAI recovered after a restart" "The app stopped answering and a restart brought it back at $(date -Iseconds). Worth a look at why."
    rm -f "$DOWN" "$FAILS"
    exit 0
  fi
fi

# Still down after a restart. This one needs a person.
alert "ElavoFishAI is DOWN" "The app has failed $COUNT health checks and a restart did not fix it.
Health URL: $URL
Host: $(hostname)
Last lines of the deploy log:
$(tail -5 "$STATE/agent.log" 2>/dev/null || echo '(none)')"
exit 1
