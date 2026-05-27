(ns frontend.hypha.config
  "Hypha build-time configuration.

  `HYPHA-MODE` is a Closure define that gates Hypha-specific code paths. It is
  set to `true` at Hypha build time via:

      --config-merge '{:closure-defines {frontend.hypha.config/HYPHA-MODE true}}'

  The default `false` keeps a stock Logseq build unaffected. The two upstream
  Mini-Hook patches that land in Hypha milestone M1 (`handler/events/ui.cljs`
  and `handler.cljs`) read `hypha-mode?` to decide whether to take the Hypha
  code path.

  V4 (2026-05-27) empirically confirmed that `--config-merge` propagates this
  define into `CLOSURE_DEFINES` for the `:app` build.")

(goog-define HYPHA-MODE false)

(defonce ^{:doc "Build-flag indicating whether this build is a Hypha build.
Read by upstream Mini-Hook patches in handler/events/ui.cljs and handler.cljs."}
  hypha-mode?
  HYPHA-MODE)
