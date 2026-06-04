#!/usr/bin/env bash
# Bring up a headless, RTC-synced Hypha graph client on this machine.
#
# Flow (all verified against notes.teuffel.io):
#   1. hypha-auth.mjs  -> exchange access code for id-token, write ~/logseq/auth.json
#   2. sync config     -> point ws-url/http-base at the Hypha server (global ~/logseq/cli.edn)
#   3. sync download   -> pull the remote graph into the local replica (first time)
#   4. sync start      -> open the RTC WebSocket (starts/uses the db-worker-node daemon)
#   5. sync status     -> show ws-state (expect "open")
#
# The db-worker-node daemon stays running after this script exits, holding the
# local replica + the open RTC connection. Writes made afterwards (via the MCP
# server or `logseq upsert ...`) reuse that daemon, so they flow through RTC to
# all browser clients within seconds.
#
# Notes:
#   - Requires Node >= 22.5 (the worker uses the node:sqlite builtin).
#   - cli.edn always lives at ~/logseq/cli.edn; --config decouples it from the
#     replica --root-dir so the right Hypha server is used.
#   - Re-run to refresh the token (the Hypha JWT lasts ~30 days, so rarely needed).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

NODE="${HYPHA_NODE:-$HOME/.local/node22/bin/node}"
HYPHA_URL="${HYPHA_URL:-https://notes.teuffel.io}"
HYPHA_GRAPH="${HYPHA_GRAPH:-teuffel.io}"
HYPHA_ROOT="${HYPHA_ROOT:-$HOME/.local/share/hypha-cli-graph}"
HYPHA_CONFIG="${HYPHA_CONFIG:-$HOME/logseq/cli.edn}"
WS_URL="${HYPHA_WS_URL:-wss://notes.teuffel.io/sync/%s}"

[ -x "$NODE" ] || { echo "hypha-sync-up: node >=22.5 not found at $NODE (set HYPHA_NODE)"; exit 1; }

CLI="$NODE $REPO/static/logseq-cli.js"
COMMON=(--graph "$HYPHA_GRAPH" --config "$HYPHA_CONFIG" --root-dir "$HYPHA_ROOT")
filter() { grep -vE 'ExperimentalWarning|trace-warnings'; }

echo "==> [1/5] auth"
HYPHA_URL="$HYPHA_URL" "$NODE" "$HERE/hypha-auth.mjs"

echo "==> [2/5] sync config"
$CLI sync config set ws-url "$WS_URL" --config "$HYPHA_CONFIG" 2>&1 | filter
$CLI sync config set http-base "$HYPHA_URL" --config "$HYPHA_CONFIG" 2>&1 | filter

echo "==> [3/5] download '$HYPHA_GRAPH' into $HYPHA_ROOT (skipped if db exists)"
if [ -f "$HYPHA_ROOT/graphs/$HYPHA_GRAPH/db.sqlite" ]; then
  echo "    db.sqlite already present, skipping download"
else
  $CLI sync download "${COMMON[@]}" --progress 2>&1 | filter
fi

echo "==> [4/5] sync start"
$CLI sync start "${COMMON[@]}" --output json 2>&1 | filter

echo "==> [5/5] sync status"
$CLI sync status "${COMMON[@]}" --output json 2>&1 | filter
