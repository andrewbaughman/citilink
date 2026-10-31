#!/usr/bin/env bash
# Backward-compatible entry point. This intentionally does not disable Chrome
# security; server.py proxies the API through the local app origin instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/server.py"
