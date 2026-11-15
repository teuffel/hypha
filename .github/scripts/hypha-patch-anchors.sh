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
  # rg -c prints nothing when there is no match. Anything that is not a plain
  # count (e.g. an rg error for a missing file) is a FAIL; it must not reach
  # the arithmetic comparison, where a syntax error aborts the whole script.
  result="${result:-0}"
  if [[ "$result" =~ ^[0-9]+$ ]] && (( result == expected )); then
    echo "PASS: $name"
  else
    echo "FAIL: $name (expected '$expected', got '$result')"
    exit_code=1
  fi
}

# === Patch #1 ===
check "patch-1: :user/login event exists" \
      "rg -c 'defevent! :user/login' src/main/frontend/handler/events/ui.cljs" \
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
      "rg -c '(rum|hsx)/defc new-db-graph-inner' src/main/frontend/components/repo.cljs" \
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
# Hypha-aware e2ee default for graphs with no explicit kv value. Lives in the
# upload path's normalize-graph-e2ee? (the actual nil->true coercion site), so
# graph-e2ee? itself stays a pure passthrough and upstream's
# graph-e2ee-preserves-nil/false-kv-value tests keep holding. Anchor on the
# patch ID comment inside the file.
check "patch-8: hypha-aware e2ee default in normalize-graph-e2ee?" \
      "rg -c 'HYPHA-PATCH-008' src/main/frontend/worker/sync/upload.cljs" \
      "1"

# === Patch #9 ===
# local-uploadable-graph? gains a defensive guard against stale repos-state
# so the toolbar doesn't render two cloud icons. Anchor on the patch-ID
# comment in components/repo.cljs.
check "patch-9: local-uploadable-graph? defends against stale :remote? flag" \
      "rg -c 'HYPHA-PATCH-009' src/main/frontend/components/repo.cljs" \
      "1"

# === Patches #10-#22 (counts measured 2026-11-14) ===
check "patch-10: e2ee password persistence secret" "rg -c 'HYPHA-PATCH-010' src/main/frontend/worker/sync/crypt.cljs" "1"
check "patch-11: back/forward buttons in installed PWA" "rg -c 'HYPHA-PATCH-011' src/main/frontend/components/header.cljs" "1"
check "patch-12a: Hypha token refresh + logout in handler/user" "rg -c 'HYPHA-PATCH-012' src/main/frontend/handler/user.cljs" "2"
check "patch-12b: worker refresh via ui-request" "rg -c 'HYPHA-PATCH-012' src/main/frontend/worker/sync/auth.cljs" "1"
check "patch-12c: :hypha-refresh-id-token ui-action" "rg -c 'HYPHA-PATCH-012' src/main/frontend/handler/worker.cljs" "1"
check "patch-13a: enriched graph-already-exists error" "rg -c 'HYPHA-PATCH-013' src/main/frontend/worker/sync/upload.cljs" "1"
check "patch-13b: name-collision catch + take-over handler" "rg -c 'HYPHA-PATCH-013' src/main/frontend/handler/db_based/sync.cljs" "2"
check "patch-13c: resolve dialog event" "rg -c 'HYPHA-PATCH-013' src/main/frontend/handler/events/rtc.cljs" "1"
check "patch-14a: no demo graph in Hypha mode" "rg -c 'HYPHA-PATCH-014' src/main/frontend/handler.cljs" "1"
check "patch-14b: name-collision banner" "rg -c 'HYPHA-PATCH-014' src/main/frontend/components/repo.cljs" "3"
check "patch-15a: literal-slash define" "rg -c 'HYPHA-LITERAL-SLASH' deps/common/src/logseq/common/util/namespace.cljs" "3"
check "patch-15b: literal-slash in outliner validate" "rg -cF 'literal-slash?' deps/outliner/src/logseq/outliner/validate.cljs" "2"
check "patch-15c: literal-slash in bin/hypha-build" "rg -c 'HYPHA-LITERAL-SLASH' bin/hypha-build" "2"
check "patch-16a: upsert page --parent in OCaml CLI" "rg -c 'HYPHA-PATCH-016' cli/lib/upsert.ml" "3"
check "patch-16b: parent fields in the upsert spec" "rg -c 'remove_parent' cli/spec/commands/upsert.mli" "2"
check "patch-18: :date by journal-day in OCaml CLI" "rg -c 'HYPHA-PATCH-018' cli/lib/upsert.ml" "1"
check "patch-20: enable-history toggle" "rg -c ':property.built-in/enable-history' src/main/frontend/components/property/config.cljs" "1"
check "patch-21a: property-history viewer" "rg -c 'property-history-cp' src/main/frontend/components/content.cljs" "2"
check "patch-21b: property-history i18n" "rg -c ':block/property-history' src/resources/dicts/en.edn" "1"
check "patch-22: web download binds runtime" "rg -c 'HYPHA-PATCH-022' src/main/frontend/handler/db_based/sync.cljs" "1"

check "patch-25a: server confirms journaled tx-ids" "rg -c 'HYPHA-PATCH-025' deps/db-sync/src/logseq/db_sync/worker/handler/sync.cljs" "1"
check "patch-25b: client acks its own tx-ids in pull/ok" "rg -c 'HYPHA-PATCH-025' src/main/frontend/worker/sync/apply_txs.cljs" "1"

check "patch-26a: server pages the pull" "rg -c 'HYPHA-PATCH-026' deps/db-sync/src/logseq/db_sync/worker/handler/sync.cljs" "1"
check "patch-26b: client pulls the next page" "rg -c 'HYPHA-PATCH-026' src/main/frontend/worker/sync/handle_message.cljs" "1"

# Future patches: add new check() lines here, parallel to HYPHA_PATCHES.md.

exit $exit_code
