#!/usr/bin/env bash
# Launches Chrome with CORS disabled in a throwaway profile so this POC's
# vanilla JS can call the SWIV Citilink API directly (it sends no CORS
# headers at all). A fresh --user-data-dir is required every run — Chrome
# silently ignores --disable-web-security when pointed at a normal profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$(mktemp -d /tmp/chrome-swiv-poc.XXXXXX)"

open -na "Google Chrome" --args \
  --disable-web-security \
  --user-data-dir="$PROFILE_DIR" \
  "file://$SCRIPT_DIR/index.html"

echo "Launched Chrome with a throwaway profile at $PROFILE_DIR"
echo "Close that Chrome window when done; the profile dir can be deleted afterward."
