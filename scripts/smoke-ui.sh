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
VIEWS="today plan best weeks water log msgs friends season species rigs scope reference profile lakes sharing blocked data"
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

[ "$FAIL" = "0" ] && echo "[smoke] all views ok" || echo "[smoke] FAILURES above" >&2
exit "$FAIL"
