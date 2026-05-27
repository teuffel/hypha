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

(For new patches: same shape. Mandatory fields: ID, file, patch form, line
count, rationale, additive alternatives considered, break signal structural +
semantic, detection, on break.)
