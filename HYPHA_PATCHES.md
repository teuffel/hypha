# HYPHA_PATCHES.md

Inventory of every line where Hypha modifies upstream Logseq code.

Order: chronological (oldest patch first).
Threshold: > 20 entries ⇒ architecture smell, refactor Hypha's interception
strategy. See `docs/hypha/phase-1-plan.md` section 8.4 for the full divergence
metrics that govern this file.

Each entry uses the same template (mandatory fields). When a patch breaks
during weekly upstream-sync, the detection grep is the first thing run; the
"Bei Bruch" instructions guide repair.

---

## Patch #1 — Login-Routing for Hypha mode

- **ID**: HYPHA-PATCH-001
- **Introduced**: Milestone M1 (Login-Spike), 2026-05-27
- **File**: `src/main/frontend/handler/events/ui.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 349)
  (defmethod events/handle :user/login [[_]]
    (if (mobile-util/native-platform?)
      (route-handler/redirect! {:to :user-login})
      (login/open-login-modal!)))

  ;; HYPHA
  (defmethod events/handle :user/login [[_]]
    (cond
      hypha-config/hypha-mode?
      (hypha-login/open-login-modal!)

      (mobile-util/native-platform?)
      (route-handler/redirect! {:to :user-login})

      :else
      (login/open-login-modal!)))
  ```
  plus two `:require` entries in the file header:
  `[frontend.hypha.config :as hypha-config]`,
  `[frontend.hypha.login :as hypha-login]`.
- **Line count**: +4 (one cond clause + if→cond restructuring) +2 requires
- **Rationale**: In Hypha mode the access-code login modal must replace
  Cognito's Amplify-driven modal. All call sites that publish `:user/login`
  (`components/settings.cljs`, `components/header.cljs`, etc.) stay
  unmodified — the single dispatcher decides.
- **Additive alternatives considered**:
  - Multimethod override from a Hypha namespace: rejected (load-order
    fragility on hot-reload — first namespace loaded wins).
  - Patching every caller: rejected (4+ patches instead of 1).
  - Wrapping `:user/login` via an event hijack: rejected (more invasive,
    higher surface for upstream divergence).
- **Break signal — structural**:
  - `defmethod events/handle :user/login` is renamed, deleted, or moved
    to another file or split across files.
- **Break signal — semantic**:
  - Cond ordering changes; a new clause lands before `hypha-mode?` and
    overshadows it.
  - `:user/login` event is replaced by a new event schema upstream.
- **Detection**:
  - Structural, automatic:
    `rg -c 'defmethod events/handle :user/login' src/main/frontend/handler/events/ui.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the first cond clause must read
    `hypha-config/hypha-mode?`.
- **On break**:
  - Structural → find the new dispatcher location, re-anchor the patch,
    update this file.
  - Semantic → fix cond ordering, or rebuild the modal opener atop the
    new event schema in `hypha-login`.

---

## Patch #2 — Hypha-init at app boot

- **ID**: HYPHA-PATCH-002
- **Introduced**: Milestone M1 (Login-Spike), 2026-05-27
- **File**: `src/main/frontend/handler.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 160, inside the app-init sequence)
  (user-handler/restore-tokens-from-localstorage)

  ;; HYPHA
  (user-handler/restore-tokens-from-localstorage)
  (when hypha-config/hypha-mode?
    (hypha-init/start!))
  ```
  plus two `:require` entries:
  `[frontend.hypha.config :as hypha-config]`,
  `[frontend.hypha.init :as hypha-init]`.
- **Line count**: +2 +2 requires
- **Rationale**: `hypha-init/start!` must run after `frontend.state` is
  initialised (which `restore-tokens-from-localstorage` does indirectly via
  `set-tokens!` even in the no-cached-tokens case) and before the first
  event publication. `start!` calls `GET /auth/session` and seeds the JWT
  into state, plus points the db-sync client at the Hypha origin via
  `localStorage.sync-server-url`.
- **Additive alternative considered**: `<script>` injection in `index.html`
  (0-patch variant) — rejected because it would have HTML and CLJS racing
  to manipulate the same state, with no clear ordering guarantee.
- **Break signal — structural**:
  - `restore-tokens-from-localstorage` is extracted out of `handler.cljs`
    or renamed.
- **Break signal — semantic**:
  - The init sequence is reordered upstream so that our
    `(when hypha-mode? (hypha-init/start!))` lands after the first event
    publication or before state initialisation.
- **Detection**:
  - Structural, automatic:
    `rg -c 'user-handler/restore-tokens-from-localstorage' src/main/frontend/handler.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the Hypha block must sit directly after
    the `restore-tokens-from-localstorage` call.
- **On break**:
  - Structural → find the new init anchor, re-place the patch.
  - Semantic → fix position, or move the patch to a more stable init
    hook.

---

---

## Patch #3 — `logged-in?` Hypha-aware

- **ID**: HYPHA-PATCH-003
- **Introduced**: Milestone M9 (Phase 1.6 cross-device), 2026-05-27
- **File**: `src/main/frontend/handler/user.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 90)
  (defn logged-in? []
    (let [token (state/get-auth-refresh-token)]
      (when (string? token)
        (not (string/blank? token)))))

  ;; HYPHA
  (defn logged-in? []
    (if hypha-config/hypha-mode?
      (when-let [token (state/get-auth-id-token)]
        (and (string? token)
             (not (-> token parse-jwt-safe expired?))))
      (let [token (state/get-auth-refresh-token)]
        (when (string? token)
          (not (string/blank? token))))))
  ```
  plus one `:require`: `[frontend.hypha.config :as hypha-config]`.
- **Line count**: +6 (3-line if-branch + 1 require)
- **Rationale**: Hypha's auth model has no refresh-token. The HttpOnly
  session cookie is the long-lived material; the JWT lives in memory only
  and is re-minted on every boot via `GET /auth/session`. The original
  `logged-in?` returns `false` in every Hypha session and hides every
  upload-to-cloud UI entry point (toolbar cloud icon at
  `components/header.cljs:33`, All-graphs "Use sync (beta)" menu item at
  `components/repo.cljs:224-233`). In Hypha mode an unexpired `:auth/id-token`
  is the only proof of authentication that exists; use it.
- **Additive alternatives considered**:
  - Sentinel value: Hypha sets `:auth/refresh-token` to the literal string
    `"hypha-session"` to satisfy the existing predicate. Rejected — hacky,
    confuses any future reader who searches for refresh-token semantics.
  - Per-call-site Hypha-aware wrappers (replace every `logged-in?` use):
    rejected — 6+ call sites instead of 1, much higher upstream
    divergence.
  - Loosen `logged-in?` upstream-wide to accept either id-token or
    refresh-token: rejected — changes Cognito behavior, risks subtle
    regressions in the stock build.
- **Break signal — structural**:
  - `logged-in?` is renamed, deleted, or split out of `frontend.handler.user`.
- **Break signal — semantic**:
  - Hypha's id-token model changes (refresh-tokens get added later); the
    if-branch becomes misleading.
  - `parse-jwt-safe` or `expired?` get renamed.
- **Detection**:
  - Structural, automatic:
    `rg -c 'defn logged-in\?' src/main/frontend/handler/user.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the function body's first form must be
    `(if hypha-config/hypha-mode? ...)`.
- **On break**:
  - Structural → find the new location of `logged-in?`, re-anchor.
  - Semantic → if a refresh-token model gets introduced to Hypha, drop
    the patch (the original predicate now works); else fix the
    branch.

---

## Patch #4 — Hypha defaults in `new-db-graph-inner`

- **ID**: HYPHA-PATCH-004
- **Introduced**: Milestone M9 (Phase 1.6 cross-device), 2026-05-27
- **File**: `src/main/frontend/components/repo.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 608)
  [creating-db? set-creating-db?] (hooks/use-state false)
  [cloud? set-cloud?] (hooks/use-state false)
  [graph-e2ee? set-graph-e2ee?] (hooks/use-state true)

  ;; HYPHA
  [creating-db? set-creating-db?] (hooks/use-state false)
  [cloud? set-cloud?] (hooks/use-state (boolean hypha-config/hypha-mode?))
  [graph-e2ee? set-graph-e2ee?] (hooks/use-state (not hypha-config/hypha-mode?))
  ```
  plus one `:require`: `[frontend.hypha.config :as hypha-config]`.
- **Line count**: +2 modified hook lines + 1 require
- **Rationale**: Stock Logseq's defaults (`cloud=off`, `e2ee=on`) reflect
  Logseq.com's public-service threat model. Hypha is a self-hosted
  personal-cloud appliance — the operator IS the user IS the trusted
  party. Flipping both defaults:
  - `cloud=on`: a new graph defaults to syncing to the user's own server.
    Without this, Phase 1.6's cross-device round-trip silently breaks for
    anyone who doesn't think to tick the box.
  - `e2ee=off`: `encrypted_private_key` is password-encrypted (PBKDF2+AES,
    `common/crypt.cljs:87-148`). The user would need to type the same
    password on every device for cross-device decryption to work — an
    extra UX layer that defeats "Personal Cloud, just works". Default-off
    sidesteps that completely; users who explicitly want E2EE retain the
    capability via the manually-tickable checkbox.
  Both checkboxes remain user-toggleable; this changes only the initial
  value.
- **Additive alternatives considered**:
  - Auto-migration of all local graphs on first login: rejected — collides
    with multi-user-design (U23 in Phase 2 plan).
  - Hide the e2ee checkbox in Hypha: rejected — loses opt-in path.
  - Hypha-side override via a `use-effect!`-set-cloud?-true: rejected —
    would render the checkbox briefly in the wrong state, plus
    introduces a render-time race.
- **Break signal — structural**:
  - `new-db-graph-inner` is renamed, deleted, or extracted from
    `frontend.components.repo`.
  - The `cloud?` / `graph-e2ee?` hook names change.
- **Break signal — semantic**:
  - Stock Logseq flips its own defaults (e.g., upstream goes to
    `cloud=true` default); the patch becomes redundant but harmless.
  - A third encryption-mode hook gets introduced; we should evaluate.
- **Detection**:
  - Structural, automatic:
    `rg -c 'rum/defc new-db-graph-inner' src/main/frontend/components/repo.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the `cloud?` and `graph-e2ee?` initial
    values must read `hypha-config/hypha-mode?`.
- **On break**:
  - Structural → re-anchor the patch in the new component location.
  - Semantic → reconcile defaults with whatever upstream landed; if
    upstream now defaults `cloud=on`, drop the cloud branch and only
    keep `graph-e2ee?` override.

---

---

## Patch #5 — db-sync snapshot-stream-url respects X-Forwarded-Host

- **ID**: HYPHA-PATCH-005
- **Introduced**: Milestone M9.5 (Phase 1.6 V10 reverse-proxy-origin-leak fix), 2026-05-28
- **File**: `deps/db-sync/src/logseq/db_sync/worker/handler/sync.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL
  (defn- snapshot-stream-url [request graph-id]
    (let [url (js/URL. (.-url request))]
      (str (.-origin url) "/sync/" graph-id "/snapshot/stream")))

  ;; HYPHA
  (defn- snapshot-stream-url
    "... reverse-proxy-aware ..."
    [request graph-id]
    (let [url (js/URL. (.-url request))
          headers (.-headers request)
          forwarded-host (some-> headers (.get "x-forwarded-host"))
          forwarded-proto (some-> headers (.get "x-forwarded-proto"))
          origin (if (seq forwarded-host)
                   (str (if (seq forwarded-proto) forwarded-proto "http")
                        "://"
                        forwarded-host)
                   (.-origin url))]
      (str origin "/sync/" graph-id "/snapshot/stream")))
  ```
- **Line count**: +13 (8 net lines of code, plus a 5-line docstring)
- **Rationale**: When db-sync runs behind hypha-server's reverse proxy,
  the request URL the adapter sees has the internal loopback host
  (`http://127.0.0.1:8787`). Using `request.url.origin` for embedded URLs
  in JSON responses (here: the `url` field of GET /sync/<id>/snapshot/download
  pointing at the follow-up /snapshot/stream fetch) makes the browser
  attempt to reach the loopback host, which fails with `TypeError: Failed
  to fetch`. This is a standard reverse-proxy pattern — the proxy sets
  `X-Forwarded-Host` + `X-Forwarded-Proto`, the downstream service uses
  them to reconstruct the public-facing URL.
- **Companion change (NOT a patch)**:
  `hypha-server/src/proxy.ts` injects these headers on every proxied path
  (rewriteRequestHeaders hook). Counts as Hypha-server-own code, not an
  upstream patch.
- **Additive alternatives considered**:
  - Modify the response body in `hypha-server` proxy with a JSON-rewrite
    hook: rejected — fragile (depends on exact response shape) and
    invasive (would need to parse + rewrite + re-serialize every response
    body that might contain URLs).
  - Make all proxied URLs relative on the db-sync side: rejected — many
    other downstream consumers (Cloudflare Worker deployments, electron
    apps) rely on absolute URLs.
  - Submit this as an upstream Logseq PR and remove the patch: ideal
    long-term, queued as a future contribution.
- **Break signal — structural**:
  - `snapshot-stream-url` is renamed, moved out of
    `logseq.db-sync.worker.handler.sync`, or has its signature changed.
- **Break signal — semantic**:
  - Logseq adds other places that build embedded URLs from
    `request.url.origin`. Those will silently break self-hosted setups
    too (and we'll need to extend the same forwarded-host pattern).
- **Detection**:
  - Structural, automatic:
    `rg -c 'defn- snapshot-stream-url' deps/db-sync/src/logseq/db_sync/worker/handler/sync.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the function body must read
    `x-forwarded-host` from `.headers`.
- **On break**:
  - Structural → find the new URL-building location, re-anchor.
  - Semantic → re-apply the X-Forwarded-Host respect logic.

---

---

## Patch #6 — Schema completeness for `:logseq.property.sync/large-title-object`

- **ID**: HYPHA-PATCH-006
- **Introduced**: Milestone M11 (Phase 1.6 cross-device snapshot-import schema fix), 2026-05-28
- **Files**:
  - `deps/db/src/logseq/db/frontend/schema.cljs`
  - `deps/db/src/logseq/db/frontend/malli_schema.cljs`
- **Patch form** (two-piece, semantically one patch — both files must move
  in lockstep to keep the db-sync adapter's symmetry check happy):

  In `schema.cljs`, add to the `(def schema ...)` map:
  ```clojure
  :logseq.property.sync/large-title-object {:db/index true}
  ```

  In `malli_schema.cljs`, extend `page-or-block-attrs`:
  ```clojure
  [:logseq.property.sync/large-title-object {:optional true} :map]
  ```
- **Line count**: ~10 (including the explanatory comments — both files
  reference the cross-device-V10 diagnosis in phase-1.6-cross-device.md
  for context).
- **Rationale**: `worker/sync/large_title.cljs` lines 51 + 259 call
  `(d/datoms db :avet :logseq.property.sync/large-title-object)`, which
  Datascript only allows when the attribute is marked `:db/index true`.
  The static Datascript schema didn't declare it. Without this patch,
  the snapshot-import path in `worker/sync/download.cljs/complete-datoms-import!`
  → `rehydrate-large-titles-from-db!` throws ("should be marked as
  :db/index true"), which the parent catches and logs as
  `:rehydrate-large-title-failed`, but downstream the UI is left in the
  "Wird heruntergeladen..." (downloading...) state. The Malli companion
  declaration is needed because the db-sync node-adapter performs a
  startup symmetry check between the Datascript schema and the Malli
  entity schemas; declaring `large-title-object` in Datascript without
  declaring it in Malli would make the adapter refuse to start.
- **Additive alternatives considered**:
  - Patch only the frontend caller (use `:eavt` + filter): rejected —
    O(N) iteration over the whole DB on every snapshot import is a
    real performance regression, and the same workaround would be
    needed if upstream Logseq ever invents another `:avet` consumer for
    this attribute.
  - Skip the call entirely with a `(try ... (catch))`: rejected —
    silently swallows future schema problems and leaves large-title
    object reconstruction half-broken.
  - Submit this to upstream Logseq as a bugfix PR and drop the patch:
    ideal long-term — when Logseq accepts it, this entry can be removed.
- **Break signal — structural**:
  - The `schema` def in `deps/db/.../schema.cljs` is renamed, moved,
    or restructured.
  - The `page-or-block-attrs` def in `malli_schema.cljs` is renamed or
    restructured.
- **Break signal — semantic**:
  - Logseq accepts the upstream fix → both lines become duplicate
    declarations.
  - The attribute is renamed or removed from upstream's built-in
    properties.
- **Detection**:
  - Structural, automatic:
    `rg -c ':logseq.property.sync/large-title-object' deps/db/src/logseq/db/frontend/schema.cljs`
    ⇒ `1`
    `rg -c ':logseq.property.sync/large-title-object' deps/db/src/logseq/db/frontend/malli_schema.cljs`
    ⇒ `1`
  - Semantic, manual at triage: both occurrences must be in the
    expected `def` (schema vs. page-or-block-attrs).
- **On break**:
  - Structural → re-anchor in whatever the new schema-map location is.
  - Semantic upstream-merged → remove both lines, leave a TODO breadcrumb
    referencing this entry's history.

---

## Patch #7 — Surface cloud-upload failures as a user notification

- **ID**: HYPHA-PATCH-007
- **Introduced**: Phase 1.6.2 (post-V10 user-visibility fix), 2026-05-28
- **File**: `src/main/frontend/handler/db_based/sync.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 407)
  (defn <rtc-upload-graph!
    [repo _graph-e2ee?]
    (if-let [operation (active-graph-operation)]
      (reject-graph-operation-in-progress :upload operation)
      (do
        (state/set-state! :rtc/uploading? true)
        (-> (p/let [_ (state/<invoke-db-worker :thread-api/db-sync-upload-graph repo)
                    _ (<get-remote-graphs)
                    _ (state/set-state! :rtc/uploading? false)
                    _ (<rtc-start! repo)]
              true)
            (p/finally
              (fn []
                (state/set-state! :rtc/uploading? false)))))))

  ;; HYPHA — adds a p/catch between the p/let and p/finally that logs
  ;; the failure under :db-sync/upload-graph-failed and surfaces it
  ;; as a notification using (t :graph/upload-failed <ex-message>).
  ```
- **Line count**: +10 (the p/catch block plus a 7-line explanatory comment
  block above it).
- **Rationale**: Stock Logseq's chain pairs p/let with p/finally only,
  no p/catch. Every rejection (worker → `:db-sync/missing-datascript-conn`,
  server → 4xx, e2ee preflight, network down, …) propagates as
  "Uncaught (in promise)" — visible only when DevTools is open. The
  spinner clears via p/finally, so the UI looks identical to success.
  Phase 1.6 V10 surfaced this as the cause of "Cloud icon clicked,
  spinner blinked, nothing synced" reports: server-side flow worked,
  but the per-user diagnosis path was silent.

  This patch adds the missing p/catch step: logs the failure under a
  structured glogi keyword and shows a single-line notification using
  the new `:graph/upload-failed` translation key. Re-rejects so any
  upstream caller still sees the rejection.

- **Companion change (NOT a patch)**:
  `src/resources/dicts/en.edn` + `src/resources/dicts/zh-cn.edn` gain
  `:graph/upload-failed "Cloud upload failed: {1}"` (i18n source plus
  zh-CN translation per `.agents/skills/logseq-i18n` mandatory locale
  policy). The key is reused only by this notification; lives between
  `:graph/updated-switching` and `:graph/upload-local-confirm-desc`.

- **Additive alternatives considered**:
  - Hypha-side wrapper that intercepts `<rtc-upload-graph!`: rejected
    — clean intercept point would still need to call the upstream
    function, which produces the same uncaught-rejection problem.
  - Worker-side notification: rejected — workers cannot dispatch UI
    notifications without round-tripping through the main thread, and
    the chain crosses both worker and frontend rejects (worker error,
    network error, e2ee setup error). The frontend catch covers them
    all uniformly.
  - Submit this to upstream Logseq as a UX bug: ideal long-term — when
    accepted upstream, this entry can be removed and the i18n key
    refactored to upstream's preferred location.

- **Break signal — structural**:
  - `<rtc-upload-graph!` is renamed, deleted, or its body is rewritten
    such that the p/let → p/finally pair no longer surrounds the worker
    invocation.
  - `notification/show!` API changes signature, or `frontend.context.i18n/t`
    moves.

- **Break signal — semantic**:
  - Upstream adds its own p/catch with a different notification — both
    would fire on the same error.
  - `:graph/upload-failed` is reused for a different message elsewhere
    (track via `bb lang:validate-translations` unused-key check).

- **Detection**:
  - Structural, automatic:
    `rg -c ':db-sync/upload-graph-failed' src/main/frontend/handler/db_based/sync.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the p/catch must call both
    `log/error` and `notification/show!`, and must re-reject so
    downstream `p/finally` still runs.

- **On break**:
  - Structural → re-anchor on the new shape of `<rtc-upload-graph!`.
  - Semantic upstream-merged → remove the patch and the dict entries.

---

## Patch #8 — Hypha-aware default for unset `graph-e2ee?` in the worker

- **ID**: HYPHA-PATCH-008
- **Introduced**: Phase 1.6.2 (companion to V10 import-then-upload diagnosis), 2026-05-28
- **Relocated**: 2026-05-29 — moved from `crypt.cljs/graph-e2ee?` into
  `upload.cljs/normalize-graph-e2ee?` so the patch sits at the actual
  `nil → true` coercion site and `graph-e2ee?` stays a pure kv passthrough.
  This keeps upstream's `graph-e2ee-preserves-nil-kv-value-test` and
  `graph-e2ee-preserves-false-kv-value-test` (added by upstream commit
  `36ae802983`) green; the earlier form changed `graph-e2ee?`'s return
  value and broke both.
- **File**: `src/main/frontend/worker/sync/upload.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 216)
  (defn- normalize-graph-e2ee?
    [graph-e2ee?]
    (if (nil? graph-e2ee?)
      true
      (true? graph-e2ee?)))

  ;; HYPHA
  (defn- normalize-graph-e2ee?
    [graph-e2ee?]
    (if (nil? graph-e2ee?)
      (not (seq (:http-base @worker-state/*db-sync-config)))
      (true? graph-e2ee?)))
  ```
- **Line count**: +8 (1 line of logic plus a 7-line explanatory comment).
  `crypt.cljs/graph-e2ee?` is left untouched at its upstream definition.
- **Rationale**: Stock Logseq's `graph-e2ee?` returns `nil` for graphs
  with no explicit `:logseq.kv/graph-rtc-e2ee?` setting. Every consumer
  in `worker/sync/{upload,assets,apply_txs,handle_message}.cljs` treats
  `nil` as truthy via `normalize-graph-e2ee?` or boolean coercion, so
  the effective default is **e2ee=true**.

  Phase 1.6 M9.3 (Patch #4) reversed the default for **new graph
  creation** UI (`new-db-graph-inner`), but did NOT propagate the same
  reversal to:

  - **Imported file-graphs**: `frontend.components.imports/import-file-graph`
    creates a DB entity without setting `:logseq.kv/graph-rtc-e2ee?`,
    so the field stays nil, and `graph-e2ee?` returns nil → caller
    interprets as true → upload-path triggers `<preflight-upload-e2ee!`
    → which calls `<load-user-rsa-key-material` → which calls
    `<decrypt-private-key` → which calls `ldb/read-transit-str` on the
    raw key blob → fails with "JSON.parse: unexpected character at line 1
    column 1" when the server's stored key isn't transit-encoded.

  - **Older graphs created before M9.3**: same nil default, same failure.

  This patch makes the upload path's `normalize-graph-e2ee?` hypha-aware:
  when the worker's `db-sync-config` has a custom `:http-base` (=
  self-hosted Hypha, set by `persist_db/browser.cljs` from
  `frontend.config/set-custom-sync-server-url!`), unset state defaults to
  **false** (no e2ee). When `:http-base` is empty (= stock Logseq pointing
  at Logseq.com), unset state keeps the safer default **true**. This is
  identical in shape to M9.3's UI default reversal, just propagated through
  the upload-path fallback. `graph-e2ee?` itself remains the upstream pure
  passthrough; the truthiness consumers (`<ensure-graph-aes-key`,
  `<grant-graph-access!`, assets, apply-txs, handle-message) already treat
  its `nil` as falsy (skip e2ee), so only the upload preflight needed the
  hypha default.

  Net effect on Hypha:
  - Newly-created via UI: M9.3 sets explicit value → unchanged.
  - Imported via folder: nil → false → upload skips e2ee entirely →
    fixes Phase 1.6 V10 user story.
  - Older graphs: nil → false → upload skips e2ee → user can opt back
    in via Settings if desired.

  Net effect on Logseq.com: unchanged (no custom server → keeps true).

- **Companion change (NOT a patch)**: none. This is a single-file
  worker-internal change.

- **Additive alternatives considered**:
  - Patch `<rtc-upload-graph!` to pass the user-confirmed `graph-e2ee?`
    through to the worker via `:thread-api/db-sync-upload-graph`:
    rejected — the parameter is currently `_graph-e2ee?` (underscored,
    unused) in upstream, suggesting Logseq intended to do this but
    didn't. Plumbing through the parameter would change the thread-api
    signature and ripple to every caller; one-line worker default is
    cleaner.
  - Patch `frontend.components.repo/graph-e2ee-enabled?` to default
    false in Hypha mode: rejected — that function's result is
    consumed by `upload-local-graph-with-confirm!` but then thrown away
    by `<rtc-upload-graph!`'s unused `_graph-e2ee?` parameter, so
    patching it has no runtime effect.
  - Set the DB KV `:logseq.kv/graph-rtc-e2ee?` explicitly to false
    during import: rejected — would require a separate migration for
    pre-existing graphs and would silently change semantics; better to
    keep the database honest and patch the consumer.
  - Submit this as an upstream Logseq fix: ideal long-term — when
    Logseq accepts a config-driven e2ee default, this entry can be
    removed.

- **Break signal — structural**:
  - `normalize-graph-e2ee?` is renamed, moved out of
    `worker/sync/upload.cljs`, or stops gating the `<preflight-upload-e2ee!`
    call.
  - `worker-state/*db-sync-config` is renamed or restructured.

- **Break signal — semantic**:
  - Upstream Logseq changes `normalize-graph-e2ee?` so nil no longer maps
    to true on its own. Then this patch becomes redundant — verify the
    upload preflight still skips e2ee for imported graphs in Hypha mode.
  - Logseq introduces a new e2ee-default semantic where unset means
    "ask the user" (UI prompt). Then the upload fallback should defer
    to that UI flow rather than silently defaulting.

- **Detection**:
  - Structural, automatic:
    `rg -c 'HYPHA-PATCH-008' src/main/frontend/worker/sync/upload.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the `(nil? graph-e2ee?)` branch must read
    `:http-base` from `worker-state/*db-sync-config`, and the polarity
    must be `(not (seq ...))` — present-http-base implies default-false.
  - Regression guard: upstream's `graph-e2ee-preserves-nil-kv-value-test`
    and `graph-e2ee-preserves-false-kv-value-test` in
    `crypt_test.cljs` must stay green (they assert `graph-e2ee?` purity).

- **On break**:
  - Structural rename → re-anchor on the new definition site.
  - Semantic upstream-merged → remove this patch and re-verify the
    import-then-upload V10 user story still works.

---

## Patch #9 — `local-uploadable-graph?` defends against stale repos-state

- **ID**: HYPHA-PATCH-009
- **Introduced**: Phase 1.6.2 follow-up (toolbar dual-cloud-icon fix), 2026-05-28
- **File**: `src/main/frontend/components/repo.cljs`
- **Patch form**:
  ```clojure
  ;; ORIGINAL (~line 34)
  (defn local-uploadable-graph?
    [{:keys [root remote?]}]
    (and (or root
             (mobile-util/native-platform?))
         (not remote?)
         (user-handler/logged-in?)
         (user-handler/rtc-group?)))

  ;; HYPHA — adds a `url` destructure and a defensive guard:
  ;; `(not (some #(= url (:url %)) (state/get-rtc-graphs)))`.
  ```
- **Line count**: +10 (1 line of guard logic + 1 destructure update + 8
  lines of explanatory comment).
- **Rationale**: Stock Logseq gates the toolbar's "manual cloud upload"
  icon (`components/header.cljs:469`) on
  `(repo/local-uploadable-graph? graph)`. That fn only looks at the
  `:remote?` flag in the repos-state. After a successful upload, the
  state propagation chain is:

  ```
  <rtc-upload-graph! → <get-remote-graphs → set-state! :rtc/graphs
                                         → repo-handler/refresh-repos!
                                         → state/set-repos! (with :remote? merged in)
  ```

  Empirically, the `:remote?` flag does NOT always end up true in the
  resulting repos-state. The diagnosis trail points at
  `combine-local-&-remote-graphs:107-134` where the merge depends on
  group-by `:url` matching across local-vs-remote and a
  `:GraphSchemaVersion` filter that can drop the remote entry. The
  symptom is two cloud icons rendered side-by-side: one with the
  green status dot from `rtc-indicator/indicator` (gated on
  `:rtc/graphs` membership + DB `:graph/rtc-uuid`, both of which ARE
  correct), and one plain cloud from `local-graph-sync-button` (gated
  on the stale `:remote? false`).

  Rather than chase the merge logic, this patch treats `:rtc/graphs`
  as the authoritative answer to "is this graph on the server?". If
  the server lists the graph by URL, hide the upload trigger. The
  worst case (false positive: stale rtc-graphs containing a server
  graph the user already deleted) still produces correct behavior:
  the upload button stays hidden, and the user has to use the
  Settings → Graphs flow to re-upload, which is the expected pattern.

- **Additive alternatives considered**:
  - Fix the merge in `combine-local-&-remote-graphs`: rejected for
    now — that fn is hot-path on every graph-list refresh and
    changes to the version-matched-merge logic risk other UX
    regressions. The defensive `local-uploadable-graph?` guard
    addresses the user-visible symptom in one place with no other
    rendering side effects.
  - Run `refresh-repos!` again after `<rtc-upload-graph!` resolves:
    rejected — that's exactly what `<get-remote-graphs` already
    does in the chain. The bug isn't a missing call; it's the
    merge result not propagating.
  - Submit as upstream Logseq bugfix PR: ideal long-term — the
    bug is universal (not Hypha-specific), so when accepted
    upstream this patch can be removed.

- **Break signal — structural**:
  - `local-uploadable-graph?` is renamed, deleted, or its destructure
    pattern changes such that the `:url` key is no longer accessible.
  - `state/get-rtc-graphs` is renamed or moves.

- **Break signal — semantic**:
  - Upstream tightens the `refresh-repos!` merge logic and the
    `:remote?` flag becomes reliable. This patch becomes redundant
    (no harm — the extra check just makes both gates evaluate the
    same answer).

- **Detection**:
  - Structural, automatic:
    `rg -c 'HYPHA-PATCH-009' src/main/frontend/components/repo.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the guard must reference
    `state/get-rtc-graphs` and be inside the `(and …)` of
    `local-uploadable-graph?`.

- **On break**:
  - Structural → re-anchor on the new shape of `local-uploadable-graph?`.
  - Semantic upstream-merged → remove the patch and re-verify the
    "two cloud icons" symptom is gone.

---

## Patch #10 — e2ee-password persistence works without a refresh-token

- **ID**: HYPHA-PATCH-010
- **Introduced**: Phase 1.6.2 follow-up (cross-device upload on a fresh
  origin behind a reverse proxy), 2026-05-29
- **File**: `src/main/frontend/worker/sync/crypt.cljs`
- **Patch form**:
  ```clojure
  ;; ADDED — secret material for the locally-persisted e2ee password.
  (defn- password-persistence-secret
    [refresh-token]
    (if (seq refresh-token)
      refresh-token
      (when (browser-runtime? (platform/current))
        (some-> (sync-util/auth-token) worker-util/parse-jwt :sub))))

  (defn- ensure-password-persistence-secret!
    [secret]
    (when-not (seq secret)
      (fail-missing-e2ee-password! {:reason :missing-refresh-token
                                    :hint "Run logseq login first."})))

  ;; <save-e2ee-password / <read-e2ee-password-text /
  ;; <decrypt-e2ee-password-text / <read-e2ee-password / <decrypt-in-headless
  ;; now resolve the refresh-token to `secret` via password-persistence-secret
  ;; and use it for encrypt/decrypt instead of the raw refresh-token.
  ```
- **Line count**: +~20 (helper pair + comment; call sites swap
  `refresh-token` → `secret`). `ensure-refresh-token!` is kept for the
  node auth-file path only.
- **Rationale**: Stock Logseq persists the e2ee password encrypted with
  the OAuth **refresh-token** as the symmetric key (so the password
  survives reboots without re-entry). Hypha's auth model has **no
  refresh-token** (Patch #3) — auth is an HttpOnly cookie session whose
  JWT is re-minted on every boot. Every e2ee-password save/read path
  therefore hit `ensure-refresh-token!` and failed with
  `:reason :missing-refresh-token`, surfacing to the user as
  `Cloud upload failed: missing-e2ee-password`. The failure fired
  **before** the entered password could take effect, so even typing a
  password could not unblock sync. The bug only manifests on a fresh
  origin (e.g. first login through a reverse proxy) where no user
  RSA-keypair exists in that origin's IndexedDB yet, forcing the
  generate path that needs to persist a password.

  This patch resolves the persistence secret through
  `password-persistence-secret`: the refresh-token when present (stock
  Logseq, CLI), else — **only in browser runtime** — the stable JWT
  `sub` (user-id). The user-id is identical across reboots and devices,
  so the saved password re-decrypts correctly. The user still chooses
  and enters the password; only the symmetric key wrapping the *stored*
  password changes from refresh-token to user-id.

  Net effect:
  - Hypha browser: password save/read works; entered once per device,
    survives reboots.
  - Stock Logseq / CLI: `(seq refresh-token)` is true → unchanged.
  - Node/CLI without refresh-token: `browser-runtime?` is false → no
    fallback → still fails as before (auth-file is the source of truth).

- **Security note**: In Hypha the *local reusability* of the persisted
  password rests on the non-secret user-id, not on a secret. The
  password itself remains the secret protecting the RSA private key.
  Acceptable under Hypha's single-user, trusts-own-server model (same
  rationale as Patch #4's e2ee-off default); it would be a weakening for
  a don't-trust-the-server threat model.

- **Companion change (NOT a patch)**: none. Single-file worker-internal
  change. The paired UI copy clarification
  (`:encryption/set-password-desc` in `components/e2ee.cljs` + dicts) is
  an additive i18n string, not an upstream-logic patch.

- **Additive alternatives considered**:
  - Synthesize a sentinel refresh-token (`"hypha-session"`) so the
    existing predicate passes: rejected — same hacky sentinel rejected
    in Patch #3; leaks Hypha-knowledge into shared crypto and would
    change the wrapping key if the sentinel ever changed.
  - Skip persisting the password entirely in Hypha (encrypt the RSA key
    with the entered password but never store it): rejected — the user
    would re-enter the password on every reboot, not just once per
    device.
  - Derive a fully passwordless key from the user-id (no prompt at all):
    rejected for now — weakens the RSA-key protection more than the user
    asked for; the user explicitly accepted entering one password.
  - Submit as upstream Logseq fix (config-driven, refresh-token-optional
    persistence): ideal long-term — when accepted upstream this entry
    can be removed.

- **Break signal — structural**:
  - `password-persistence-secret` or `ensure-password-persistence-secret!`
    is renamed/removed, or a save/read path reverts to using the raw
    `refresh-token` for encrypt/decrypt.
  - `sync-util/auth-token`, `browser-runtime?`, or `worker-util/parse-jwt`
    is renamed/moved.

- **Break signal — semantic**:
  - Upstream makes refresh-token optional for password persistence (e.g.
    keys the stored password off the user-id or a device key). Then this
    patch becomes redundant — verify the Hypha upload still works on a
    fresh origin.
  - Hypha gains a real refresh-token model. Then the fallback is dead
    code and can be dropped.

- **Detection**:
  - Structural, automatic:
    `rg -c 'HYPHA-PATCH-010' src/main/frontend/worker/sync/crypt.cljs`
    ⇒ `1`
  - Semantic, manual at triage: `password-persistence-secret` must gate
    the user-id fallback on `browser-runtime?`, and the save/read paths
    must encrypt/decrypt with the resolved `secret`, not the raw
    refresh-token.
  - Regression guard: `save-e2ee-password-missing-refresh-token-in-auth-file-test`
    and `decrypt-private-key-headless-ignores-config-e2ee-password-test`
    (node-path, must still fail) plus the two
    `*-falls-back-to-user-id-in-browser-without-refresh-token-test`
    cases (browser-path, must succeed) in `crypt_test.cljs`.

- **On break**:
  - Structural → re-anchor on the new save/read secret-resolution shape.
  - Semantic upstream-merged → remove the patch and re-verify the
    fresh-origin upload user story still works.

---

## Patch #11 — Show back/forward buttons in installed-PWA windows

- **ID**: HYPHA-PATCH-011
- **Introduced**: Phase 1.6.2 follow-up (Chrome-App / installed-PWA UX),
  2026-05-29
- **File**: `src/main/frontend/components/header.cljs`
  (plus an additive helper in `src/main/frontend/util.cljc`)
- **Patch form**:
  ```clojure
  ;; ORIGINAL (header.cljs ~line 484)
  (when (util/electron?)
    (back-and-forward))

  ;; HYPHA
  (when (or (util/electron?) (util/standalone-display-mode?))
    (back-and-forward))

  ;; ADDED (util.cljc) — additive helper, no upstream behavior change:
  (defn standalone-display-mode?
    "True when the page runs in an installed PWA / Chrome-App-style window
    (no browser chrome). Detected via `display-mode: standalone`."
    []
    (boolean
     (when (and js/window (exists? js/window.matchMedia))
       (.-matches (js/window.matchMedia "(display-mode: standalone)")))))
  ```
- **Line count**: +1 in header.cljs (plus a 4-line guidance comment),
  +9 in util.cljc (additive helper + docstring).
- **Rationale**: Stock Logseq gates the `back-and-forward` toolbar
  component on `(util/electron?)` alone (header.cljs:484). The hidden
  assumption is "a normal browser tab already has back/forward buttons
  in the browser toolbar, so showing in-app duplicates is noise". That
  assumption breaks for installed PWAs / Chrome-Apps, which run in a
  standalone window **without** browser chrome — the user then has no
  way to navigate Logseq's own URL history.

  Self-hosting Hypha users commonly open the web app this way (Chrome →
  "Install app"), so the missing buttons are a recurring UX paper-cut.
  This patch widens the gate to also include
  `(util/standalone-display-mode?)`, which uses the standard
  `display-mode: standalone` media query — the same signal browsers use
  to identify installed PWAs.

  The component itself (`back-and-forward`) calls plain
  `js/window.history.back/forward`, so no Electron-specific API is
  involved; the original code already worked in any browser, the gate
  was the only barrier.

- **Net effect**:
  - Normal browser tab → buttons hidden (unchanged; browser toolbar
    suffices).
  - Electron app → buttons shown (unchanged).
  - Installed PWA / Chrome-App standalone window → buttons **now
    shown**, restoring parity with the Electron app.

- **Companion change (NOT a patch)**: none — the `util/standalone-display-mode?`
  helper is purely additive and could be upstreamed without behavior
  change.

- **Additive alternatives considered**:
  - Always show the buttons in the web: rejected — duplicates the
    browser toolbar buttons in the common case of a regular tab.
  - Gate on `hypha-mode?`: rejected — the missing buttons are a generic
    PWA UX issue, not Hypha-specific. Gating on Hypha would leave stock
    Logseq PWA users with the same paper-cut.
  - Detect via `window.navigator.standalone` (Safari-only legacy
    property): rejected — does not fire in Chromium-based PWAs, which is
    Hypha's primary target.
  - Submit as upstream Logseq fix: ideal long-term — the bug is
    universal. When accepted upstream, this entry can be removed and
    `standalone-display-mode?` becomes a regular helper.

- **Break signal — structural**:
  - `back-and-forward` is renamed/moved out of `header.cljs`, or its
    callsite gate is rewritten.
  - `util/electron?` or `util/standalone-display-mode?` is
    renamed/removed.

- **Break signal — semantic**:
  - Upstream introduces a runtime predicate that already covers
    "browser chrome absent" (e.g. `util/standalone?`). Then the patch
    becomes redundant — switch the gate to that predicate.

- **Detection**:
  - Structural, automatic:
    `rg -c 'HYPHA-PATCH-011' src/main/frontend/components/header.cljs`
    ⇒ `1`
  - Semantic, manual at triage: the `back-and-forward` callsite gate
    must include `(util/standalone-display-mode?)` as an `or` branch
    alongside `(util/electron?)`.

- **On break**:
  - Structural rename → re-anchor the gate on the new callsite or
    predicate.
  - Semantic upstream-merged → remove the patch and re-verify the
    Chrome-App user story.

---

(For new patches: same shape. Mandatory fields: ID, file, patch form, line
count, rationale, additive alternatives considered, break signal structural +
semantic, detection, on break.)
