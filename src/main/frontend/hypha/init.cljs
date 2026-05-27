(ns frontend.hypha.init
  "Hypha runtime initialization, called from the app boot sequence.

  M0 (current): no-op stub. Establishes the public entry point that Patch #2
  in `frontend/handler.cljs` will call from milestone M1.

  M1 (next): full implementation will

  1. Set `localStorage.sync-server-url` to `window.location.origin` so the
     db-sync client targets the Hypha endpoint instead of the Logseq cloud.
  2. Call GET `/auth/session` to exchange the HttpOnly Hypha session cookie
     for a fresh JWT; place that JWT into `state/state[:auth/id-token]`.
  3. If the session call returns 401, publish `[:user/login]` which Patch #1
     in `handler/events/ui.cljs` routes to the Hypha-AccessCode login modal.

  See `docs/hypha/phase-1-plan.md` section 4.6 for the auth flow.")

(defn start!
  "Hypha-mode app-boot entry point.

  Called from `frontend.handler` after `restore-tokens-from-localstorage`,
  but only when `frontend.hypha.config/hypha-mode?` is true (Patch #2).

  Returns `nil`. In M0 this is a deliberate no-op; M1 will populate the body."
  []
  nil)
