# Phase 1.5 — Plugin-Marketplace

**Status:** Plan (vor Implementation)
**Vorgänger:** Phase 1 (M0–M4 + cross-origin-isolation Polish) — abgeschlossen
**Nachfolger:** Phase 2 (Multi-User + Realtime-Collab)

## 0. Warum Phase 1.5, nicht Phase 2

Plugin-Marketplace lebt zwischen Phase 1 (Single-User-Personal-Cloud) und Phase 2 (Multi-User-Team-Server):

- **Single-User-konsistent** wie Phase 1. Plugins gehören "dem Nutzer", keine ACL-Komplexität.
- **0 Upstream-Patches** wie Phase 1. Alles additiv (Hypha-Server-Proxy + CLJS-Stubs in eigenen Namespaces).
- **Hypha-eigene Plugin-Liste lebt in IndexedDB** wie Logseq.com — keine Server-Side-Persistenz nötig.
- **Aber:** das ist ein UX-Feature, kein neues Architektur-Kapitel wie Realtime.

Plan-Disziplin: gleiches Format wie phase-1-plan.md (Annahmen → Verifikationen → Meilensteine → Patches), aber kleinerer Umfang (≈ 1/3 der Größe).

## 1. Architekturbasis (was schon im Code lebt)

### 1.1 Plugin-System ist im Hypha-Build aktiv

Per `config.cljs:149`:

```clojure
(defonce lsp-enabled?
  (and util/plugin-platform?           ;; TRUE in Hypha web build
       (not (false? feature-plugin-system-on?))  ;; TRUE (ENABLE-PLUGINS default)
       (state/lsp-enabled?-or-theme)))            ;; user toggle
```

`plugin-platform?` ist `(or (and web-platform? (not common-config/PUBLISHING)) (electron?))`, also `true` für Hypha. Plugin-System läuft beim App-Start automatisch los — daher die "logseq-plugin-tags zu lange zum Laden"-Warnungen die schon in M4-Real-Browser-Test sichtbar waren.

### 1.2 Marketplace-Endpoints

```
GET https://raw.githubusercontent.com/logseq/marketplace/master/plugins.json
GET https://raw.githubusercontent.com/logseq/marketplace/master/stats.json
GET https://raw.githubusercontent.com/logseq/marketplace/master/packages/<id>/<asset>
GET https://plugins.logseq.io/r2/<repo>/<version>   ← Cloudflare-R2-Plugin-Bundles
```

Stand 2026-05: 550 Plugins total; 276 (50%) passieren den Web-Mode-Filter
`(or :web=true (not :effect=true))`.

CORS-Verifikation 2026-05-27: beide Endpoints liefern `access-control-allow-origin: *`,
direkter Browser-Fetch funktioniert.

### 1.3 Plugin-Storage in Web-Mode (Logseq vanilla)

| Was | Wo |
|---|---|
| Installed-Plugin-Liste | IndexedDB key `LSPUserDotRoot/installed-plugins/<id>.json` |
| User-Preferences | IndexedDB key `LSPUserDotRoot/preferences.json` |
| Plugin-Code (JS) | wird bei jedem App-Start frisch fetched (Browser-HTTP-Cache hilft) |
| Plugin-Assets (Icons, CSS) | nicht persistent — fetched on demand |

Phase-1.5 lässt diesen Storage-Layer unangetastet. Server-Side-Persistenz der Plugin-Liste ist Phase-2-Material (sobald Multi-User existiert, brauchen wir per-User-Listen).

### 1.4 17 Web/Desktop-Verzweigungen in plugin.cljs

Logseq hat `util/electron?`-Branches an jedem Storage-Touchpunkt:

- Install: `(ipc/ipc :installMarketPlugin …)` ↔ `(async-install-or-update-for-web! …)` (common/plugin.cljs:72)
- User-Prefs: `fs/create-if-not-exists + read-file` ↔ `idb/get-item + set-item!` (plugin.cljs:996-1023)
- Marketplace-Fetch: `(ipc/ipc :httpFetchJSON)` ↔ `(util/fetch)` (plugin.cljs:209-213)
- Auto-Update-Check: gespiegelte Pfade in beide Welten (plugin.cljs:251-327)

Alle Web-Pfade sind implementiert. Hypha erbt das ohne Anfassen.

### 1.5 `setup-global-apis-for-web!` (plugin.cljs:152)

```clojure
(defn setup-global-apis-for-web!
  []
  (when (and util/web-platform? (nil? js/window.apis))
    (let [^js e (js/window.EventEmitter3.)]
      (set! (. js/window -apis) e))))
```

Plugin-Code, das `js/window.apis.openExternal(...)` aufruft (üblich), schickt
auf einem EventEmitter ohne Empfänger — kein Crash, aber das Plugin wartet
auf Antwort und timeoutet → die "zu lange zum Laden"-Warnungen.

## 2. Was Hypha Phase-1.5 hinzufügt

### 2.1 Caching-Reverse-Proxy in hypha-server

Drei neue Routes auf `hypha-server`:

```
GET /plugin-market/plugins.json       → proxies raw.githubusercontent.com/.../plugins.json,
                                         cached 1h server-side
GET /plugin-market/stats.json          → proxies stats.json, cached 1h
GET /plugin-market/packages/<id>/<f>   → proxies packages/<id>/<f>, cached 24h
GET /plugin-cdn/r2/<repo>/<ver>        → proxies plugins.logseq.io/r2/<repo>/<ver>,
                                         cached 24h
GET /plugin-cdn/r2/<repo>/<ver>/<f>    → proxies binary plugin assets, cached 24h
```

Cache lebt im RAM mit LRU-Eviction (mat. via `node-cache` oder ähnliches; kein
Persistent-Disk-Cache für Phase 1.5 — das wäre M-Scope-Premature).

**Warum überhaupt proxien wenn CORS schon OK ist:**
- Offline-resilient: Logseq.io oder GitHub-CDN down → Hypha-Cache antwortet
- Schneller: ein Cold-Hit ist langsamer als ein Hot-Cache
- Plugin-Bundles sind oft mehrere MB — server-side TTL reduziert Bandwidth bei Multi-Device-Setups
- Vorbereitung für Phase 2: dieselbe Proxy-Schicht wird dort persistent-disk-cached für Air-gapped Multi-User-Setups

### 2.2 CLJS-Konfig: Marketplace-URLs umlenken (via fetch-Interception)

`frontend/handler/plugin.cljs` hat hardcoded URLs:

```clojure
(defonce central-endpoint "https://raw.githubusercontent.com/logseq/marketplace/master/")
(defonce plugins-url (str central-endpoint "plugins.json"))
(defonce stats-url   (str central-endpoint "stats.json"))
```

Plus `common/plugin.cljs:12`:
```clojure
(util/node-path.join "https://plugins.logseq.io/r2" repo version)
```

**V2-Befund (2026-05-27):** alle Plugin-Marketplace-HTTP-Calls gehen letztlich
durch `window.fetch` — entweder direkt (`common/plugin.cljs:18`) oder via
`util/fetch` (`util.cljc:212` ruft `(js/fetch url ...)`). Statt CLJS-Konstanten
zu modifizieren wird `window.fetch` im Hypha-Init monkeypatched mit einem
prefix-basierten Redirect:

```clojure
;; src/main/frontend/hypha/plugin_init.cljs (Phase-1.5)
(defn install-fetch-redirect!
  "Redirect Marketplace + R2-CDN fetches to Hypha-Server proxy routes.
   Idempotent: skips if already installed (window.fetch.__hyphaWrapped)."
  []
  (let [orig (.-fetch js/window)]
    (when-not (.-__hyphaWrapped orig)
      (let [wrapped (fn [url & args]
                      (let [url' (if (string? url)
                                   (-> url
                                       (string/replace
                                        #"^https://raw\.githubusercontent\.com/logseq/marketplace/master/"
                                        "/plugin-market/")
                                       (string/replace
                                        #"^https://plugins\.logseq\.io/r2/"
                                        "/plugin-cdn/r2/"))
                                   url)]
                        (.apply orig js/window (cons url' args))))]
        (set! (.-__hyphaWrapped wrapped) true)
        (set! (.-fetch js/window) wrapped)))))
```

Wird in `frontend.hypha.init/start!` aufgerufen, BEVOR Plugin-Init läuft.
Filter-by-Prefix → Plugin-eigene Fetches an andere Hosts bleiben unangetastet.

**Konsequenz: 0 Upstream-Patches für die URL-Umlenkung.**

Alternative (verworfen): `defonce` → `goog-define`-Konvertierung wäre ein
Mini-Hook-Patch, jedoch fragiler (URL-Konstanten könnten umbenannt werden,
mehrere Touch-Punkte). Fetch-Interception überlebt Renames durch
prefix-basiertes Matching.

### 2.3 Erweiterung von `setup-global-apis-for-web!`

Statt eines stummen EventEmitter3 setzt Hypha-Init Stubs für die gängigsten
`js/window.apis.*`-Methoden:

| Methode | Hypha-Stub |
|---|---|
| `openExternal(url)` | `window.open(url, "_blank", "noopener,noreferrer")` |
| `checkForUpdate()` | `Promise.resolve({hasUpdate: false})` |
| `httpFetchJSON(url)` | direkter `fetch(url).then(r => r.json())` |
| `showItemInFolder(p)` | no-op + Notification "filesystem access not available in Hypha" |
| `relaunch()` | `window.location.reload()` |

Liste wächst empirisch — siehe V3 unten (manuelle Smoke-Tests welche
`window.apis.*`-Calls die top-10-Web-Plugins machen).

Implementation in `frontend.hypha.init` (existierendes Namespace) als
zusätzliche Setup-Phase neben dem aktuellen `/auth/session`-Flow.

### 2.4 Plugin-Lade-Indicator-Polish (optional)

Logseq's Indicator zeigt "logseq-plugin-tags zu lange zum Laden" als Warnung.
Solange Plugins langsam booten, ist das berechtigt. Polish-Möglichkeit:
Per-Plugin-Timeout im Hypha-Build hochsetzen (z. B. 30s statt 10s), damit
kalte Cache-Misses nicht als "broken" rüberkommen.

→ goog-define `frontend.config/PLUGIN-LOAD-TIMEOUT-MS` (default 10000). Hypha
setzt auf 30000. **Kein Patch — Closure-Define wie HYPHA-MODE.**

Aber: nur falls die Symptom-Warnung tatsächlich stört. Möglicherweise nach
Proxy-Caching-Implementation gar nicht mehr relevant. Verifikation V4 unten.

## 3. Constraints

| Aspekt | Wert | Begründung |
|---|---|---|
| Patches gegen Upstream | **0–1** | Phase-1-Disziplin; Plan-Default = 0, Eskalation auf 1 Mini-Hook nur bei V2-Negativ |
| Hypha-Server-Routes neu | 5 (`/plugin-market/*`, `/plugin-cdn/r2/*`) | Caching-Proxy |
| CLJS-Module neu | 1 (`frontend.hypha.plugin-init`) | Stubs für `window.apis.*` + URL-Override |
| Build-Flags neu | 0 oder 1 (`PLUGIN-LOAD-TIMEOUT-MS` Closure-Define) | Nur falls nötig |
| Persistente Plugin-Liste server-side | NEIN (Phase 2) | Single-User passt zu IndexedDB |
| Disk-Cache für Proxy | NEIN (Phase 2) | Memory-LRU reicht für Single-User-Performance |
| WebSocket-Plugin-API | NEIN (Phase 2) | Nicht nötig solange kein Realtime-Plugin existiert |

## 4. Annahmenkatalog

| ID | Aussage | Verifikation | Wann |
|---|---|---|---|
| P1 | `plugins.logseq.io/r2/<repo>/<ver>` liefert JSON-Manifest mit Plugin-Code-URLs, die ohne Auth fetchbar sind | V1 (curl-Probe gegen 5 bekannte Web-Plugins) | vorab |
| P2 | Plugin-Marketplace-Calls gehen alle durch `window.fetch` — Monkey-Patch davon umlenkt ohne Upstream-Patch | V2 (Code-Reading util/fetch + common/plugin.cljs) | vorab |
| P3 | `setup-global-apis-for-web!` läuft AUSSCHLIESSLICH wenn `lsp-enabled?` true ist — und vor jedem Plugin-Init | V3 (Code-Reading + Bootstrap-Trace) | vorab |
| P4 | Memory-LRU-Cache im Proxy ist effektiv (Hit-Rate >80% bei realer Nutzung mit 2-3 installierten Plugins, 1h TTL) | V4 (Empirisch: Container starten, top-5 Plugins installieren, Cache-Stats checken) | nach M1 |
| P5 | Die "zu lange zum Laden"-Warnung verschwindet nach Caching-Proxy + window.apis-Shims (≥ 5 von 7 :web=true-Plugins booten unter 5s) | V5 (Browser-Smoke + Timing) | nach M2 |
| P6 | Bei Cache-Miss antworten beide Upstream-Endpoints in <2s, sodass die User-Wahrnehmung "responsive" bleibt | V6 (Curl-Timing) | nach M1 |

## 5. Verifikationen (vorab abzuarbeiten)

### V1 — `plugins.logseq.io/r2`-Probe — STATUS: GRÜN (2026-05-27)

```bash
$ curl -sI https://plugins.logseq.io/r2/debanjandhar12/logseq-anki-sync
HTTP 200, TIME 1.5s
keys: [author, dependencies, description, devDependencies,
       license, logseq, main, name, repository, scripts]
main: "dist/index.html"           ← iframe entry path
logseq.id, logseq.icon            ← Plugin-Manifest-Block
```

Befund: R2-Endpoint ist ein GitHub-API-Wrapper (502 mit "GitHub API request
failed (404)" bei nicht-existierendem Repo). Bestätigt Cache-Bedarf (60/hr
unauth Rate-Limit auf GitHub-API) und Service-Drift-Risiko (2 von 3 Probes
timed out). Hypha-Cache schützt vor beiden.

### V2 — Window-Fetch-Interception statt URL-Override — STATUS: GRÜN (2026-05-27)

**Befund beim Code-Reading von `util/fetch` (util.cljc:212):**

```clojure
#?(:cljs
   (defn fetch
     ([url opts on-ok on-failed]
      (-> (js/fetch url (bean/->js opts))   ;; ruft window.fetch direkt
          (.then ...)))))
```

UND `common/plugin.cljs:18`:
```clojure
^js res (js/window.fetch url)
```

→ **alle Marketplace-Routen gehen letztlich durch `window.fetch`**.
Hypha kann das im Boot monkeypatchen mit prefix-basiertem Redirect (siehe
Architektur §2.2). Kein `defonce`-Override, kein Upstream-Patch.

**Vergleich Plan-Original vs. Plan-Update:**

| Eigenschaft | defonce→goog-define | fetch-interception |
|---|---|---|
| Patches gegen Upstream | +1 Mini-Hook | **0** |
| Drift-Resilienz | bricht bei URL-Rename | überlebt durch Prefix-Filter |
| Touch-Punkte | 2 (plugin.cljs:55, common/plugin.cljs:12) | 1 (hypha.plugin-init) |
| Debugging-Klarheit | direkt | +1 Stack-Frame pro Fetch |

→ Fetch-Interception gewählt. Phase-1.5 Patches-Budget: **0**.

### V3 — Bootstrap-Ordering von `setup-global-apis-for-web!`

Grep + Trace:
- Wo wird `setup-global-apis-for-web!` aufgerufen?
- Läuft das vor oder nach `frontend.hypha.init/start!`?
- Können wir Hypha-Stubs ANSTATT/NACH dem EventEmitter setzen?

Per `plugin.cljs:152`-Definition: läuft nur wenn `js/window.apis` noch nil ist.
Hypha-Init könnte vorher `set! js/window.apis` mit unseren Stubs setzen → Logseq
sieht es bereits gesetzt und überspringt seine eigene Initialisierung.

### V4 — Cache-Hit-Rate

Nach M1 (Proxy implementiert):
- Container starten
- 3 Plugins installieren (z. B. `logseq-anki-sync`, `logseq-plugin-bidi`, ein Theme)
- App F5'en 3x
- Cache-Stats-Endpoint (`/health?detail=cache`) abfragen → Hit-Rate prüfen

### V5 — End-to-End Smoke

Nach M2 (Stubs + URL-Override):
- Container starten
- Settings → Plugins → Marketplace öffnen → Plugin-Browse rendert in <2s
- 2 Plugins installieren → keine "zu lange zum Laden"-Warnung in 3 von 5 Plugins
- Plugin-Funktion exercieren (z. B. Slash-Command des Plugins) → reagiert

### V6 — Upstream-Latenz unter Cache-Miss

Curl-Probe vom Hypha-Container heraus:

```bash
time curl -s https://plugins.logseq.io/r2/logseq/logseq-plugin-tags > /dev/null
time curl -s https://raw.githubusercontent.com/logseq/marketplace/master/plugins.json > /dev/null
```

Beide Latenzen <2s erwartet. Wenn höher: Hinweis für Phase-2-Disk-Cache.

## 6. Komponenten-Mapping

| Komponente | Sitz | Sprache | Upstream-Berührung |
|---|---|---|---|
| Marketplace-Proxy | `hypha-server/src/routes/plugin-market.ts` | TypeScript | 0 |
| Plugin-CDN-Proxy | `hypha-server/src/routes/plugin-cdn.ts` | TypeScript | 0 |
| Memory-LRU-Cache | `hypha-server/src/plugin-cache.ts` | TypeScript | 0 |
| Hypha-Plugin-Init | `src/main/frontend/hypha/plugin_init.cljs` | ClojureScript | 0 (additive ns) |
| Fetch-Interception (URL-Redirect) | `src/main/frontend/hypha/plugin_init.cljs` | ClojureScript | 0 (V2-confirmed) |
| Build-Flag-Erweiterung | `bin/hypha-build` | Bash | 0 (additive --config-merge) |
| Headless-Plugin-Smoke | `hypha-server/test/playwright/plugin-marketplace.spec.ts` | TypeScript | 0 |

**Patches-Budget Phase-1.5: 0.** (V2 hat die fetch-interception-Lösung bestätigt
und damit den potenziell-eskalierenden Patch #3 obsolet gemacht.)

## 7. Meilensteine

### M5 — Marketplace-Proxy + Cache (≈ 3 Tage)

**Scope:** Caching-Proxy für GitHub-Marketplace-JSON + Plugins.logseq.io/r2.

**Hypha-Dateien neu:**
- `hypha-server/src/plugin-cache.ts` (LRU mit TTL pro Route)
- `hypha-server/src/routes/plugin-market.ts` (3 Routes: plugins.json, stats.json, packages/*)
- `hypha-server/src/routes/plugin-cdn.ts` (R2-Proxy für Plugin-Bundles)
- `hypha-server/src/app.ts` (erweitert: 2 Route-Registrationen)
- `hypha-server/test/plugin-cache.test.ts` (Cache-LRU-Logik)
- `hypha-server/test/plugin-market-proxy.test.ts` (Routing + Mocked-Upstream)

**Verifiziert / nutzt Annahme:** P1, P4, P6

**DoD:**
- `curl localhost:3030/plugin-market/plugins.json` → JSON mit ≥ 500 Plugins (Mirror der Upstream-JSON)
- `curl localhost:3030/plugin-cdn/r2/logseq/logseq-plugin-tags` → JSON-Manifest
- Cache-Hit-Rate >80% nach 3 F5 (V4)
- Cache-Miss-Latenz <2s vom Container heraus (V6)
- `pnpm --dir hypha-server test` 100% grün

### M6 — CLJS-Stubs + Plugin-Init (≈ 2 Tage)

**Scope:** Plugin-Bootstrap im Hypha-Mode mit fetch-Interception + `window.apis`-Stubs.

**Hypha-Dateien neu:**
- `src/main/frontend/hypha/plugin_init.cljs` (Hypha-Plugin-Bootstrap-Code)

**Hypha-Dateien erweitert:**
- `src/main/frontend/hypha/init.cljs` (ruft `plugin_init/setup!` falls `lsp-enabled?`)

**Upstream-Berührung:** 0 (V2-GRÜN bestätigt fetch-interception ohne Patch).

**DoD:**
- Browser-Network-Tab: `GET https://raw.githubusercontent.com/.../plugins.json` wird umgeleitet zu `GET /plugin-market/plugins.json` (Interceptor aktiv)
- `js/window.apis.openExternal("https://example.com")` öffnet neuen Tab
- Settings → Plugins → Marketplace lädt + zeigt Plugin-Karten in <2s
- Mindestens 1 Plugin installiert lassen sich + dessen Slash-Command/UI ist aktiv

### M7 — Headless-Plugin-Smoke + CI (≈ 1 Tag)

**Scope:** Playwright-Test der den Plugin-Marketplace-Pfad in der CI verifiziert.

**Hypha-Dateien neu:**
- `hypha-server/test/playwright/plugin-marketplace.spec.ts`

**Hypha-Dateien erweitert:**
- `.github/workflows/hypha-build.yml` (Smoke-Test wird in der CI ausgeführt)

**DoD:**
- Playwright-Test öffnet `/`, loggt sich ein, navigiert zu Plugins-Modal, prüft dass Plugin-Liste rendert mit ≥ 100 Einträgen
- Plugin-Install-Pfad (gegen einen statischen :web=true-Test-Plugin): startet Install, JSON-Manifest-Fetch hat 200
- CI-Run grün

## 8. Patches-Inventur (Update zu Phase 1)

```
Phase 1 (M0-M4 + Polish):    2 Mini-Hook-Patches  (#1 + #2)
Phase 1.5 (M5-M7):           0  (V2-bestätigt: fetch-interception ersetzt defonce-override)
─────────────────────────────────────
Phase-1.5-Total:             2 von 20 (10% der Smell-Schwelle, unverändert gegenüber Phase 1)
```

HYPHA_PATCHES.md bleibt unverändert. `.github/scripts/hypha-patch-anchors.sh`
braucht keinen neuen Eintrag.

## 9. CI-Erweiterung

- `.github/workflows/hypha-build.yml` ergänzt: `pnpm --dir hypha-server exec playwright test test/playwright/plugin-marketplace.spec.ts`
- `.github/workflows/upstream-sync.yml` ergänzt: gleicher Playwright-Test im Sync-Smoke-Gate (Drift-Detektion für Upstream-Marketplace-Format-Änderungen)

Da Phase 1.5 keinen neuen Patch einführt, braucht `hypha-patch-anchors.sh`
keinen zusätzlichen Check. Die zwei bestehenden Checks (Patch #1 + #2) bleiben
authoritativ.

**Drift-Schutz für fetch-interception:** der Playwright-Test in M7 prüft
implizit dass der Interceptor noch greift (Network-Tab zeigt Hypha-Proxy-URLs
statt Upstream). Falls Upstream irgendwann von `window.fetch` zu z.B.
`window.XMLHttpRequest` wechselt, fällt der Test sofort aus.

## 10. Operationale Aspekte (Hypha-Deployment)

- **Disk-Cache:** Phase 1.5 = Memory-LRU. Bei Container-Restart leeres Cache. Cold-Hit auf jeden Plugin-Browse direkt nach Restart. Phase-2-Material: Persistent-Disk-Cache in /data/plugin-cache/
- **Update-Pull:** Logseq-Marketplace updated → Hypha-Cache zeigt veraltete Liste bis TTL abläuft. Per Default 1h für JSON, 24h für Plugin-Bundles. Kann via `?refresh=1` Query-Param forciert werden (M6-stretch).
- **Air-Gapped-Setup:** Phase 1.5 funktioniert nicht offline. Air-Gapped-Deployment ist Phase-2-Scope (Persistent-Disk-Cache + Hypha-eigene Marketplace-Spiegel-CLI).

## 11. Sign-off-Status (Plan Phase 1.5)

| Aspekt | Stand |
|---|---|
| Architekturbasis | Web-Plugin-System in Logseq schon vollständig, Hypha proxied + shimmt nur |
| Scope-Wahl | S — Caching-Proxy + window.apis-Stubs + fetch-Interception |
| Patches-Budget | 2 (Phase 1) + 0 (Phase 1.5) = **2 von 20** (unverändert) |
| Empirische Daten | 550 Marketplace-Plugins, 276 web-kompatibel; beide Endpoints CORS-OK |
| Annahmenkatalog | P1-P6 spezifiziert |
| Verifikationen | V1 grün, V2 grün (vorab); V3-V6 milestone-gated |
| Meilensteine | 3 (M5 Proxy + M6 Init + M7 CI-Smoke), Σ ≈ 1 Woche |
| Risiko-Stellen | V2 hat fetch-interception als 0-Patch-Lösung etabliert; verbleibendes Risiko: M5-Cache-Hit-Rate (V4) |
| Test-Surface | 19 hypha-server + neue plugin-cache + plugin-proxy + 1 Playwright |
| CI-Erweiterung | hypha-build.yml + upstream-sync.yml |

**Nächster Schritt:** M5 starten (Marketplace-Proxy + Cache in hypha-server).
