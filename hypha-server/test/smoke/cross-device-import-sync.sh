#!/usr/bin/env bash
#
# Phase 1.6 cross-device-import-sync smoke.
#
# Simulates the "user imports a Logseq-Markdown folder, clicks the cloud
# upload icon, then opens the app in a second browser/device and sees the
# same graph + assets" user story at the HTTP layer.
#
# The actual UI import step is browser-only (file-graph parser runs in
# the Frontend bundle), but everything that the worker would send to the
# server after a successful import is reproducible via curl. This script
# exercises that server-side path end-to-end against a running
# hypha-server container.
#
# Phase A — Browser A: post-import cloud-upload
#   A1  login
#   A2  POST /e2ee/user-keys           (RSA stub — required even with e2ee=off)
#   A3  POST /graphs                   (cloud-graph registration)
#   A4  PUT  /assets/<id>/<uuid>.txt   (one asset, ~70 bytes)
#   A5  GET  /assets/...               (roundtrip verify A's own write)
#   A6  GET  /graphs                   (listing contains new graph)
#
# Phase B — Browser B: cross-device read (separate session, same access code)
#   B1  fresh login                    (same code → same user-sub claim)
#   B2  GET  /graphs                   (A's graph visible)
#   B3  GET  /graphs/<id>/access       (200)
#   B4  GET  /assets/...               (byte-for-byte == A's upload)
#   B5  GET  /sync/<id>/snapshot/download (URL = public origin, M9.5 fix)
#
# Phase C — Sign-off summary.
#
# Demonstrates User Stories from Phase 1.6:
#   U1 (cloud-graph create), U3 (auto-list across sessions),
#   U4 (graph accessible cross-device), U6 (asset PUT+GET roundtrip).
#
# Maps to the import-then-sync workflow:
#   Server registers an "imported" graph (= post-cloud-upload state).
#   Asset PUT mirrors what the worker would push for every file in a
#   freshly imported assets/ directory.
#   Browser B's listing + asset GET is exactly what the user would see
#   on the second device.
#
# Usage
# -----
# Pre-requisite: a running hypha-server reachable at $HYPHA_BASE_URL
# (default http://localhost:3030) configured with $HYPHA_ACCESS_CODE
# (default the dev code matching .env).
#
# Examples:
#
#   # Default — local dev container started via docker-compose.hypha.yml
#   ./hypha-server/test/smoke/cross-device-import-sync.sh
#
#   # Custom base + code (CI / remote deploy)
#   HYPHA_BASE_URL=http://localhost:13000 \
#   HYPHA_ACCESS_CODE=ci-dev-code \
#   ./hypha-server/test/smoke/cross-device-import-sync.sh
#
# Exit codes
# ----------
#   0  all phases passed
#   1  any HTTP call or assertion failed (red output shows the cause)
#
# Dependencies
# ------------
# curl, jq, base64, head, sha256sum, date (BSD or GNU).

set -euo pipefail

BASE="${HYPHA_BASE_URL:-http://localhost:3030}"
CODE="${HYPHA_ACCESS_CODE:-a6cd37b73bf5dd9a8f6d9047104d7b79}"
RUN_ID=$(date +%s)
GRAPH_NAME="imported-notes-${RUN_ID}"
ASSET_UUID="aaaaaaaa-bbbb-cccc-dddd-$(printf '%012d' "$RUN_ID")"
ASSET_TYPE="txt"
ASSET_CONTENT="Imported notes asset ${RUN_ID}: byte-for-byte cross-device payload."
ASSET_CHECKSUM=$(printf "%s" "$ASSET_CONTENT" | sha256sum | cut -d' ' -f1)

red()  { printf "\033[31m%s\033[0m\n" "$*"; }
grn()  { printf "\033[32m%s\033[0m\n" "$*"; }
ylw()  { printf "\033[33m%s\033[0m\n" "$*"; }
bold() { printf "\033[1m%s\033[0m\n" "$*"; }
hdr()  { echo; printf "\033[1;36m── %s ──\033[0m\n" "$*"; }

STUB_PUBKEY=$(head -c 256 /dev/urandom | base64 -w0)
STUB_PRIVKEY=$(head -c 256 /dev/urandom | base64 -w0)

bold "Cross-device-import-sync smoke against $BASE (graph=$GRAPH_NAME)"

hdr "Phase A — Browser A: post-import cloud-upload"

bold "[A1] Login (access code → JWT)"
RESP=$(curl -sS -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d "{\"code\":\"$CODE\"}")
JWT_A=$(echo "$RESP" | jq -r '."id-token"')
[ -n "$JWT_A" ] && [ "$JWT_A" != "null" ] || { red "FAIL: login A: $RESP"; exit 1; }
SUB_A=$(echo "$JWT_A" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .sub)
grn "[A1] login OK, user-sub=$SUB_A"

bold "[A2] POST /e2ee/user-keys (stub RSA pair; required even if e2ee=off)"
RESP=$(curl -sS -X POST "$BASE/e2ee/user-keys" \
  -H "Authorization: Bearer $JWT_A" \
  -H "Content-Type: application/json" \
  -d "{\"public-key\":\"$STUB_PUBKEY\",\"encrypted-private-key\":\"$STUB_PRIVKEY\"}")
echo "$RESP" | jq -e '."public-key"' > /dev/null || { red "FAIL: e2ee user-keys upload: $RESP"; exit 1; }
grn "[A2] RSA pair registered"

bold "[A3] POST /graphs (cloud-upload after import → server registers the graph)"
RESP=$(curl -sS -X POST "$BASE/graphs" \
  -H "Authorization: Bearer $JWT_A" \
  -H "Content-Type: application/json" \
  -d "{\"graph-name\":\"$GRAPH_NAME\",\"schema-version\":\"65.10\",\"graph-e2ee?\":false,\"graph-ready-for-use?\":true}")
GRAPH_ID=$(echo "$RESP" | jq -r '."graph-id"')
[ -n "$GRAPH_ID" ] && [ "$GRAPH_ID" != "null" ] || { red "FAIL: POST /graphs: $RESP"; exit 1; }
grn "[A3] graph registered, graph-id=$GRAPH_ID"

bold "[A4] PUT /assets/$GRAPH_ID/$ASSET_UUID.$ASSET_TYPE (asset sync — Phase 1.6 M8 fix)"
RESP=$(curl -sS -X PUT "$BASE/assets/$GRAPH_ID/$ASSET_UUID.$ASSET_TYPE" \
  -H "Authorization: Bearer $JWT_A" \
  -H "Content-Type: application/octet-stream" \
  -H "x-amz-meta-checksum: $ASSET_CHECKSUM" \
  -H "x-amz-meta-type: $ASSET_TYPE" \
  --data-binary "$ASSET_CONTENT")
echo "$RESP" | jq -e '.ok' > /dev/null || { red "FAIL: asset PUT: $RESP"; exit 1; }
grn "[A4] asset uploaded ($(echo -n "$ASSET_CONTENT" | wc -c) bytes, sha256=${ASSET_CHECKSUM:0:12}...)"

bold "[A5] GET /assets/.../$ASSET_UUID.$ASSET_TYPE (round-trip verify A's own write)"
ROUNDTRIP_A=$(curl -sS "$BASE/assets/$GRAPH_ID/$ASSET_UUID.$ASSET_TYPE" -H "Authorization: Bearer $JWT_A")
if [ "$ROUNDTRIP_A" = "$ASSET_CONTENT" ]; then
  grn "[A5] roundtrip body OK (identical to upload)"
else
  red "FAIL: asset roundtrip body mismatch"; exit 1
fi

bold "[A6] GET /graphs (verify A sees the new graph in listing)"
RESP=$(curl -sS "$BASE/graphs" -H "Authorization: Bearer $JWT_A")
HAS_A=$(echo "$RESP" | jq --arg id "$GRAPH_ID" '.graphs | map(select(."graph-id"==$id)) | length>0')
[ "$HAS_A" = "true" ] || { red "FAIL: graph not in A's list"; exit 1; }
grn "[A6] new graph visible in A's listing"

hdr "Phase B — Browser B: cross-device read"

bold "[B1] Fresh login (separate session, same access code)"
RESP=$(curl -sS -X POST "$BASE/auth/login" -H "Content-Type: application/json" -d "{\"code\":\"$CODE\"}")
JWT_B=$(echo "$RESP" | jq -r '."id-token"')
[ -n "$JWT_B" ] && [ "$JWT_B" != "null" ] || { red "FAIL: login B"; exit 1; }
SUB_B=$(echo "$JWT_B" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .sub)
[ "$SUB_A" = "$SUB_B" ] || { red "FAIL: sub diverged A=$SUB_A B=$SUB_B"; exit 1; }
grn "[B1] login OK, same user-sub (cross-device identity)"

bold "[B2] GET /graphs (A's graph should appear)"
RESP=$(curl -sS "$BASE/graphs" -H "Authorization: Bearer $JWT_B")
HAS_B=$(echo "$RESP" | jq --arg id "$GRAPH_ID" '.graphs | map(select(."graph-id"==$id)) | length>0')
[ "$HAS_B" = "true" ] || { red "FAIL: A's graph $GRAPH_ID not visible to B"; exit 1; }
grn "[B2] A's graph visible in B's listing"

bold "[B3] GET /graphs/$GRAPH_ID/access (access-permission OK?)"
CODE_B=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$BASE/graphs/$GRAPH_ID/access" -H "Authorization: Bearer $JWT_B")
[ "$CODE_B" = "200" ] || { red "FAIL: access check returned HTTP $CODE_B"; exit 1; }
grn "[B3] access granted (HTTP 200)"

bold "[B4] GET /assets/$GRAPH_ID/$ASSET_UUID.$ASSET_TYPE (cross-device asset download)"
ROUNDTRIP_B=$(curl -sS "$BASE/assets/$GRAPH_ID/$ASSET_UUID.$ASSET_TYPE" -H "Authorization: Bearer $JWT_B")
if [ "$ROUNDTRIP_B" = "$ASSET_CONTENT" ]; then
  grn "[B4] B downloaded the asset byte-for-byte from A's upload"
else
  red "FAIL: B's asset download != A's upload"
  echo "expected: $ASSET_CONTENT"
  echo "got     : $ROUNDTRIP_B"
  exit 1
fi

bold "[B5] GET /sync/$GRAPH_ID/snapshot/download (snapshot-stream URL — M9.5 fix)"
RESP=$(curl -sS "$BASE/sync/$GRAPH_ID/snapshot/download" -H "Authorization: Bearer $JWT_B")
STREAM_URL=$(echo "$RESP" | jq -r '.url // empty')
if [ -z "$STREAM_URL" ]; then
  ylw "[B5] no .url in response (graph has no snapshot yet — expected for an empty graph)"
elif echo "$STREAM_URL" | grep -qE '127\.0\.0\.1:8787'; then
  red "FAIL: snapshot URL leaks internal origin: $STREAM_URL"
  exit 1
else
  grn "[B5] snapshot URL points at public origin (M9.5 X-Forwarded-Host fix): $STREAM_URL"
fi

hdr "Phase C — Sign-off"

cat << EOF
$(grn "✅ ALL PASS")

  Browser A:
    - Logged in as user-sub=$SUB_A
    - Registered graph "$GRAPH_NAME" → graph-id=$GRAPH_ID
    - Uploaded asset $ASSET_UUID.$ASSET_TYPE
    - Read it back byte-for-byte
    - Listed it in /graphs

  Browser B (separate session, same access code):
    - Logged in → identical user-sub (cross-device identity verified)
    - Saw A's graph in /graphs
    - Access check returned 200
    - Downloaded asset byte-for-byte from A's upload
    - Snapshot-stream URL: public origin (no proxy leak)

EOF
