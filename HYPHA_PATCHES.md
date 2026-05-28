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

(For new patches: same shape. Mandatory fields: ID, file, patch form, line
count, rationale, additive alternatives considered, break signal structural +
semantic, detection, on break.)
