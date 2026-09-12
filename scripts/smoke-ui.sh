#!/bin/sh
# UI smoke tests — does the app actually boot in a browser?
#
#   ./scripts/smoke-ui.sh
#
# The server suite never loads public/index.html, so a typo in the nav model or
# a stray syntax error ships silently and blanks the app for everyone. This
# renders the real page in headless Chrome, once per view, and checks that the
# view opened and nothing threw. The page sets data-js-error on <html> from its
# own window.onerror handler, which is what "nothing threw" means here.
#
# Skips (exit 0) when no Chrome is installed, so it never blocks a test run on
# a machine without one.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAGE="file://$REPO_DIR/public/index.html"
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  command -v "$c" >/dev/null 2>&1 && { CHROME="$c"; break; }
done
[ -n "$CHROME" ] || { echo "[smoke] no Chrome found — skipping UI smoke tests"; exit 0; }

# One view per primary nav entry, plus a Settings child and a Lake guide child.
VIEWS="today feed market wall group alerts plan log friends water season species rigs scope reports reference profile lakes sharing blocked data"
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for v in $VIEWS; do
  OUT="$TMP/$v.html"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=6000 \
    --dump-dom "$PAGE#$v" > "$OUT" 2>/dev/null || true

  if [ ! -s "$OUT" ]; then
    echo "[smoke] FAIL $v — page produced no DOM"; FAIL=1; continue
  fi
  # The page's own error handler stamps this attribute on <html>. Match the
  # element, not the string — the handler's own source is in the dumped DOM.
  ERR="$(grep -oE '<html[^>]*data-js-error="[^"]*"' "$OUT" | head -1 || true)"
  if [ -n "$ERR" ]; then
    echo "[smoke] FAIL $v — JavaScript error: ${ERR#*data-js-error=}"; FAIL=1; continue
  fi
  # The requested panel must be the visible one...
  if ! grep -qE "<section[^>]*id=\"p-$v\"[^>]*>" "$OUT"; then
    echo "[smoke] FAIL $v — no panel p-$v in the DOM"; FAIL=1; continue
  fi
  if grep -oE "<section[^>]*id=\"p-$v\"[^>]*>" "$OUT" | grep -q "hidden"; then
    echo "[smoke] FAIL $v — panel p-$v stayed hidden"; FAIL=1; continue
  fi
  # ...and the shell must have rendered around it.
  if ! grep -q 'class="nav-i' "$OUT"; then
    echo "[smoke] FAIL $v — sidebar navigation did not render"; FAIL=1; continue
  fi
  echo "[smoke] ok   $v"
done

# Today must actually paint its cards, not just exist.
if grep -q 'id="todayCards"></div>' "$TMP/today.html" 2>/dev/null; then
  echo "[smoke] FAIL today — dashboard cards are empty"; FAIL=1
fi

# Every in-page navigation target must resolve to a view that exists. A button
# wired to the wrong attribute or a renamed view is silently dead otherwise —
# it looks fine and does nothing when tapped.
TARGETS="$(grep -oE 'data-go="[a-z-]+"' "$TMP/today.html" | sed 's/.*="//;s/"//' | sort -u)"
if [ -z "$TARGETS" ]; then
  echo "[smoke] FAIL today — no navigation targets found (are the quick actions wired?)"; FAIL=1
fi
for t in $TARGETS; do
  if ! grep -q "id=\"p-$t\"" "$TMP/today.html"; then
    echo "[smoke] FAIL today — button targets '$t', which is not a view"; FAIL=1
  fi
done
QA="$(grep -c 'class="quick"' "$TMP/today.html" || true)"
[ "$QA" = "0" ] && { echo "[smoke] FAIL today — quick actions missing"; FAIL=1; }

# Every button in the quick-action row must carry a target the handler reads.
# Checking only the buttons that DO have data-go is useless: a button wired to
# the wrong attribute is invisible to that check and dead on the page — which
# is exactly how all four shipped broken.
QUICK="$(sed -n 's/.*<div class="quick">\(.*\)<\/div>.*/\1/p' "$TMP/today.html" | head -1)"
if [ -n "$QUICK" ]; then
  BTNS="$(printf '%s' "$QUICK" | grep -o '<button' | wc -l | tr -d ' ')"
  WIRED="$(printf '%s' "$QUICK" | grep -o 'data-go=' | wc -l | tr -d ' ')"
  if [ "$BTNS" != "$WIRED" ]; then
    echo "[smoke] FAIL today — $BTNS quick-action buttons but only $WIRED wired to data-go"; FAIL=1
  fi
fi
# The messages pane must actually be wired. wireMessages() bailed out silently
# for weeks because it looked for an element id the redesign had renamed, so
# the send button, the thread list and Enter-to-send were all dead while the
# page looked perfect. The wiring now marks itself, and this checks the mark.
if ! grep -q 'id="c-msgs"[^>]*data-wired="1"' "$TMP/friends.html"; then
  if ! grep -q 'data-wired="1"' "$TMP/friends.html"; then
    echo "[smoke] FAIL friends — the messages pane is not wired up"; FAIL=1
  fi
fi

# Every help topic must be reachable from somewhere in the app. A registry
# entry nobody can open is the same as no explanation at all.
TOPICS="$(grep -oE '^  [a-z]+:\{t:' "$REPO_DIR/public/index.html" | sed 's/:{t:$//' | tr -d ' ' | sort -u)"
for topic in $TOPICS; do
  if ! grep -qE "data-help=\"$topic\"|helpBtn\('$topic'\)" "$REPO_DIR/public/index.html"; then
    echo "[smoke] FAIL help — topic '$topic' is explained but nothing opens it"; FAIL=1
  fi
done

# No stray attribute names that nothing listens for.
if grep -qE 'data-(goto|navto|view)=' "$TMP/today.html"; then
  echo "[smoke] FAIL today — button uses an attribute no handler reads: $(grep -oE 'data-(goto|navto|view)="[^"]*"' "$TMP/today.html" | head -1)"; FAIL=1
fi

[ "$FAIL" = "0" ] && echo "[smoke] all views ok" || echo "[smoke] FAILURES above" >&2
exit "$FAIL"
