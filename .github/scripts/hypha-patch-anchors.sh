#!/usr/bin/env bash
#
# Patch-Anchor verifier for HYPHA_PATCHES.md.
#
# Per Hypha-Patch entry, runs the structural detection grep documented in
# HYPHA_PATCHES.md and prints PASS/FAIL. Exits non-zero on any failure so
# CI (notably the weekly upstream-sync action) can gate the merge.
#
# Add a new check() call here whenever a new patch is added to
# HYPHA_PATCHES.md, in the same chronological order, with the same grep
# documented under "Detection: structural, automatic".

set -u
exit_code=0

check() {
  local name="$1"
  local cmd="$2"
  local expected="$3"
  local result
  result=$(bash -c "$cmd" 2>&1)
  # Numerical comparison: -eq tolerates trailing whitespace (rg -c "1\n"),
  # and falls through to FAIL when result is non-numeric (e.g. rg error).
  if [[ "$result" -eq "$expected" ]] 2>/dev/null; then
    echo "PASS: $name"
  else
    echo "FAIL: $name (expected '$expected', got '$result')"
    exit_code=1
  fi
}

# === Patch #1 ===
check "patch-1: :user/login multimethod exists" \
      "rg -c 'defmethod events/handle :user/login' src/main/frontend/handler/events/ui.cljs" \
      "1"

# === Patch #2 ===
check "patch-2: restore-tokens-from-localstorage call exists in handler.cljs" \
      "rg -c 'user-handler/restore-tokens-from-localstorage' src/main/frontend/handler.cljs" \
      "1"

# === Patch #3 ===
check "patch-3: logged-in? defn exists in handler/user.cljs" \
      "rg -c 'defn logged-in\?' src/main/frontend/handler/user.cljs" \
      "1"

# === Patch #4 ===
check "patch-4: new-db-graph-inner component exists in components/repo.cljs" \
      "rg -c 'rum/defc new-db-graph-inner' src/main/frontend/components/repo.cljs" \
      "1"

# === Patch #5 ===
check "patch-5: snapshot-stream-url defn exists in deps/db-sync handler/sync.cljs" \
      "rg -c 'defn- snapshot-stream-url' deps/db-sync/src/logseq/db_sync/worker/handler/sync.cljs" \
      "1"

# === Patch #6 (two files, lockstep) ===
# Match the code line (with :db/index true) not the explanatory comment.
check "patch-6a: large-title-object indexed in deps/db schema.cljs" \
      "rg -c ':logseq.property.sync/large-title-object \{:db/index true' deps/db/src/logseq/db/frontend/schema.cljs" \
      "1"

# Match the malli vector form, not any future comment that might mention the keyword.
check "patch-6b: large-title-object declared in deps/db malli_schema.cljs" \
      "rg -c '\[:logseq.property.sync/large-title-object' deps/db/src/logseq/db/frontend/malli_schema.cljs" \
      "1"

# === Patch #7 ===
# The p/catch block logs under :db-sync/upload-graph-failed before showing
# the notification — that keyword is the structural anchor.
check "patch-7: <rtc-upload-graph! catches and notifies via :db-sync/upload-graph-failed" \
      "rg -c ':db-sync/upload-graph-failed' src/main/frontend/handler/db_based/sync.cljs" \
      "1"

# === Patch #8 ===
# Worker-side graph-e2ee? hypha-aware default. Anchor on the patch ID comment
# inside the file; the function name graph-e2ee? alone is not unique enough.
check "patch-8: graph-e2ee? defaults to false in hypha mode" \
      "rg -c 'HYPHA-PATCH-008' src/main/frontend/worker/sync/crypt.cljs" \
      "1"

# === Patch #9 ===
# local-uploadable-graph? gains a defensive guard against stale repos-state
# so the toolbar doesn't render two cloud icons. Anchor on the patch-ID
# comment in components/repo.cljs.
check "patch-9: local-uploadable-graph? defends against stale :remote? flag" \
      "rg -c 'HYPHA-PATCH-009' src/main/frontend/components/repo.cljs" \
      "1"

# Future patches: add new check() lines here, parallel to HYPHA_PATCHES.md.

exit $exit_code
