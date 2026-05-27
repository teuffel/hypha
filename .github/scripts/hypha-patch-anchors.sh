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

# Future patches: add new check() lines here, parallel to HYPHA_PATCHES.md.

exit $exit_code
