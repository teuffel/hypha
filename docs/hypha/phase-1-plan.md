# Hypha Phase-1-Plan

**Status:** implementation-bereit.
**Quelle:** konsolidierte Architektur-Sitzung 2026-05-27.
**Patch-Budget:** 2 Mini-Hooks, ~6 Zeilen Upstream.

---

## Kontext

Hypha ist ein Fork von `logseq/logseq`, der Logseq als selbst-hostbaren, server-basierten, web-nativen Service betreibt. Arbeitsname „Hypha", Lizenz AGPL-3.0.

**Zentraler Constraint:** Upstream-Mergebarkeit dominiert alle Architekturentscheidungen. Hypha-Code lebt in eigenen Top-Level-Verzeichnissen, modifiziert Upstream-Code nur an klar abgegrenzten Mini-Hook-Stellen, und wird wöchentlich gegen `logseq/logseq:master` rebased.

---

## Architekturentscheidungen (locked in)

| Aspekt | Entscheidung |
|---|---|
| Architekturbasis | Option A — db-sync als Server-Kern (`deps/db-sync`-Node-Adapter selbst gehostet) |
| Branch-Basis | `master` (DB-Version, SQLite-as-source-of-truth) |
| Backend-Sprache | TypeScript (`hypha-server/`, fastify + jose + fastify-http-proxy) |
| Token-Lifetime | RS256-JWTs, 30 Tage Expiry, kein Refresh-Loop |
| JWT-Claims-Format | `iss`, `aud`, `exp`, `sub`, `email`, `name`, `cognito:username` UND `preferred_username` mit identischem Wert |
| Login-Routing | Patch #1 (Mini-Hook in `handler/events/ui.cljs:349`) |
| Hypha-Init | Patch #2 (Mini-Hook in `handler.cljs:160`) |
| Auth-Flow | HttpOnly-Session-Cookie + `/auth/session`-Endpoint + JWT-im-JS-Speicher (nicht in localStorage) |
| WS-Token-Transport | Query-Param `?token=<jwt>` (existierende db-sync-Konvention) |
| Markdown-Mirror | Default aus |
| Logseq-Import | erbt aus Upstream (file-graph + DB-graph beide unterstützt) |
| Build | `clojure -M:cljs release app db-worker --config-merge '{:closure-defines {frontend.hypha.config/HYPHA-MODE true}}'` |
| `shadow-cljs.edn` | unangetastet |
| FS-/PersistentDB-Adapter | 0 Patches in Phase 1 |

---

## 1. Codebase-Map

### Legende

- `(additiv)` — Bestehender Extension Point oder Registry. Hypha-Code kommt daneben ohne Upstream-Berührung.
- `(Mini-Hook)` — Genau eine zusätzliche Zeile in Upstream-Code nötig.
- `(invasiv)` — Substantielle Veränderung bestehender Logik. Soll für Option A nirgends auftauchen.

### 1.1 Filesystem-Layer

#### `frontend.fs/Fs` — Datei-Operationen (Assets, Config, Backups)

- **Definition:** `src/main/frontend/fs/protocol.cljs` (14 Methoden, sauber)
- **Implementierungen:** `frontend.fs.memory-fs`, `frontend.fs.node` (Electron native)
- **Dispatcher:** `frontend.fs/get-fs` (`src/main/frontend/fs.cljs:28–50`) — harte `cond`-Kette ohne Registry
- **Verdict:** `(Mini-Hook)` möglich, **aber für Option A nicht in Phase 1 nötig** — Assets bleiben in OPFS/Electron-FS

#### `frontend.persist-db/PersistentDB` — SQLite-Persistenz

- **Definition:** `src/main/frontend/persist_db/protocol.cljs` (7 Methoden, SQLite-orientiert)
- **Implementierungen:** `persist-db.browser` (OPFS + sqlite-wasm), `persist-db.remote` (Electron-IPC zu `db-worker-node`)
- **Dispatcher:** `frontend.persist-db/<start-runtime!` (`:203–212`) — `cond` über `electron-runtime?`
- **Verdict:** `(additiv)` — Hypha läuft im Browser-Pfad, kein Eingriff

### 1.2 DataScript-Graph-Layer

#### Frontend-Seite (`frontend.db*`, `frontend.handler/*`)

- DataScript-Conn im Worker (`frontend.worker.state/*db-conns`)
- Frontend liest reaktiv über `frontend.db`, Transaktionen via `frontend.db.transact/transact`
- **Verdict:** `(additiv)` — kein Eingriff, Tx fließen automatisch durch db-sync

#### Worker-Seite (`frontend.worker/*`)

- Platform-Abstraktion `frontend.worker.platform` mit Browser/Node-Varianten — sauber multi-target-fähig
- `:db-worker-node`-Build (`shadow-cljs.edn:88–98`) nutzt Node-Variante, wird im Hypha-Server gehostet
- **Verdict:** `(additiv)` — bereits sauber gelöste Multi-Target-Erweiterung

### 1.3 DB-Sync / Server-Sync-Layer (Kern-Integrationspunkt für Hypha)

#### Client-Seite

| Stelle | Datei | Verdict |
|---|---|---|
| Server-URL-Override | `frontend.config/db-sync-ws-url` + `db-sync-http-base` (`config.cljs:88–100`) liest `localStorage.sync-server-url` | `(additiv)` |
| Build-Flag-Pattern | `ENABLE-DB-SYNC-LOCAL` als `goog-define` (`shadow-cljs.edn:46`) | `(additiv)`, reusable für `HYPHA-MODE` |
| Bearer-Token-Header | `frontend.handler.db-based.sync/auth-headers` (`db_based/sync.cljs:35–37`) liest `state/get-auth-id-token` | `(additiv)` |
| Sync-Client-Init | `frontend.worker.sync`, `frontend.worker.sync.transport`, `frontend.worker.sync.auth` | `(additiv)` — spricht das in `docs/agent-guide/db-sync/protocol.md` festgehaltene Protokoll |

#### Server-Seite (`deps/db-sync/`)

- **Node-Adapter:** `deps/db-sync/src/logseq/db_sync/node/` — selbst-hostbarer HTTP+WS-Server, build via `pnpm --dir deps/db-sync build:node-adapter` → `deps/db-sync/worker/dist/node-adapter.js`
- **Storage:** `node/storage.cljs` schreibt SQLite + Tx-Logs in `DB_SYNC_DATA_DIR` (env)
- **Auth-Konfig:** `node/config.cljs:20–22` (Cognito-Env-Vars), `worker/auth.cljs:46–82` (JWT-Verifikation)
- **Verdict:** `(additiv)` — Server läuft so wie er ist hinter Hypha-Reverse-Proxy. Hypha-Spezifika (AccessCode, JWT-Issuance) in `hypha-server/`

### 1.4 Auth & Identität

| Komponente | Datei | Verdict |
|---|---|---|
| Login-UI | `components/user/login.cljs` | `(additiv)` — alternativer Mount via Patch #1 |
| Token-State | `frontend.state/set-auth-id-token` (`state.cljs:1941`) | `(additiv)` — Hypha-Login ruft direkt |
| Cognito-Refresh-Loop | `handler/user.cljs:187–230` (`<refresh-tokens`, `<refresh-id-token&access-token`) | **0 Patches**: `when-let [refresh-token]`-Guard hält no-op, wenn Hypha keinen Refresh-Token setzt (siehe V2) |
| JWT-Verifikation Server | `deps/db-sync/worker/auth.cljs` + `deps/common/.../authorization/verify-jwt` | `(additiv)` — generisch RS256/JWKS, nur Env-Var-Namen sind Cognito-benamst (siehe V1) |

### 1.5 UI-Layer

Für Option A weitgehend unverändert. Hot-Spots:

| Komponente | Beobachtung | Verdict |
|---|---|---|
| `components/repo.cljs` | Multi-Graph-Picker | `(additiv)` — UI-Suppression via Hypha-Modul |
| `components/header.cljs:164` | `login?` aus `:auth/id-token` | `(additiv)` — funktioniert mit Hypha-Token genauso |
| `components/settings.cljs` | Custom-sync-server-URL-Setting existiert UI-seitig | `(additiv)` — Hypha kann den vorhandenen Pfad nutzen |
| `components/rtc/*` | RTC-spezifische UI | `(additiv)` — bleibt aktiv (sogar erwünscht für Multi-Tab-Konsistenz) |
| `components/user/login.cljs` | Cognito-Login-Flow | `(additiv)` — alternativer Mount via Patch #1 |

### 1.6 Electron-spezifisch (`src/electron/`, `src/main/electron/`)

Für Option A komplett irrelevant. Hypha-Build kompiliert nur `:app` + `:db-worker`. **Verdict:** `(additiv)` durch Nicht-Bauen.

### 1.7 Web-Demo / Browser-only-Pfad

- **Build-Target:** `:app` in `shadow-cljs.edn:17`
- **DB-Persistenz:** OPFS + sqlite-wasm via `frontend.worker.platform.browser`
- **Sync:** db-sync-Client im Worker, WS+HTTP gegen konfigurierten Server
- **Asset-Storage:** OPFS via `frontend.common.file.opfs`
- **Verdict:** `(additiv)` — Hypha läuft hier durch reine Konfiguration

### 1.8 Mobile / Capacitor

Nicht im Scope für Phase 1. `(additiv)` durch Nichts-Tun.

### 1.9 Build & Konfiguration

| Stelle | Datei | Verdict |
|---|---|---|
| Shadow-Targets | `shadow-cljs.edn` | `(additiv)` — Hypha nutzt `--config-merge`, keine neue Target |
| Webpack | `webpack.config.js` | `(additiv)` |
| Gulpfile | `gulpfile.js` | `(additiv)` — vermutlich nicht benötigt im Server-Bundle |
| Package-Scripts | `package.json:54–119` | `(additiv)` — eigene Hypha-Scripts |
| Dockerfile | bisher keiner | pure Hypha-Datei, `(additiv)` |

### 1.10 Hypha-spezifischer Code (vorgeschlagene Top-Level-Trennung)

| Pfad | Inhalt |
|---|---|
| `hypha-server/` | Node-TypeScript-Service. Wrappt db-sync-Node-Adapter, fügt AccessCode-Auth, JWT-Issuance, Reverse-Proxy, Statics-Serving hinzu. **Nicht Teil des ClojureScript-Builds.** |
| `src/main/frontend/hypha/` | Alle Hypha-spezifischen CLJS-Erweiterungen (Login-Modul, Init, Feature-Toggles). Eigenes Verzeichnis vermeidet Streuung. |
| `Dockerfile.hypha`, `docker-compose.hypha.yml` | Hypha-Distro-Build |
| `HYPHA_PATCHES.md` | Patch-Inventur mit Bruchsignal-Feldern |
| `docs/hypha/` | Hypha-eigene Docs (dieses Dokument + spätere Splits in M4) |

---

## 2. db-test-Klärung

**Befund:** `github.com/logseq/db-test` ist kein parallel entwickeltes Code-Repo, sondern Issue-Tracker für die DB-Version. Belegstelle: `README.md:81`.

Die tatsächlichen Wahlmöglichkeiten waren:
- `master` (DB-Version, aktiv entwickelt, Mergeability lohnt)
- `version/file` (Legacy-File-Version, eingefroren bei 0.10.x, Mergeability funktionslos)

Da Option A gewählt: **`master` ist die Basis.** Punkt 2 erzeugt keine offene Aktion.

---

## 3. FS-Adapter-Analyse

### Reframing

Die Storage-Layer von Logseq-Master sind nicht ein Layer, sondern zwei:

| Layer | Protokoll | Zweck | Backends |
|---|---|---|---|
| A. Datei-Operationen | `frontend.fs/Fs` (`src/main/frontend/fs/protocol.cljs`) | Lesen/Schreiben/Listen einzelner Dateien | `frontend.fs.node` (Electron native), `frontend.fs.memory-fs` |
| B. SQLite-DB-Persistenz | `frontend.persist-db/PersistentDB` (`src/main/frontend/persist_db/protocol.cljs`) | Open/Close/Export/Import einer Graph-DB | `frontend.persist-db.browser` (OPFS + sqlite-wasm), `frontend.persist-db.remote` (Electron-IPC) |

IndexedDB als Storage-Backend existiert auf `master` **nicht mehr**, nur noch als Index-Cache.

### Interface-Pseudocode

#### Layer A — `frontend.fs/Fs`

```clojure
(defprotocol Fs
  ;; Mandatory
  (mkdir!         [this dir])
  (mkdir-recur!   [this dir])
  (readdir        [this dir])
  (unlink!        [this repo path opts])
  (rmdir!         [this dir])
  (read-file      [this dir path opts])
  (read-file-raw  [this dir path opts])
  (write-file!    [this repo dir path content opts])
  (rename!        [this repo old-path new-path])
  (copy!          [this repo old-path new-path])
  (stat           [this path])
  ;; Optional
  (open-dir       [this dir])
  (get-files      [this dir])
  (watch-dir!     [this dir options])
  (unwatch-dir!   [this dir]))
```

Dispatcher in `frontend.fs/get-fs` (hardcoded `cond`).

#### Layer B — `frontend.persist-db/PersistentDB`

```clojure
(defprotocol PersistentDB
  (<list-db                [this])
  (<new                    [this repo opts])
  (<unsafe-delete          [this repo])
  (<release-access-handles [this repo])
  (<fetch-initial-data     [this repo opts])
  (<export-db              [this repo opts])
  (<import-db              [this repo data]))
```

Dispatcher in `frontend.persist-db/<start-runtime!` (hardcoded `cond`).

### Adapter-Registrierung ohne Modifikation?

**Layer A:** Nein, hardcoded `cond`. Kleinste Änderung: eine `cond`-Klausel — Mini-Hook.
**Layer B:** Nein, hardcoded `cond` + `get-impl`. Kleinste Änderung: analog.

Pattern (falls je nötig):
```clojure
(defn get-fs [dir & {:keys [repo rpath] :as opts}]
  (or (hypha-fs/dispatch dir opts)   ; <- additive Klausel, fail-soft (nil = nicht zuständig)
      (cond
        ;; … bisherige Klauseln unverändert …
        )))
```

**Für Hypha-Phase-1: beide Layer brauchen keinen Patch.** Integration läuft über db-sync.

---

## 4. Server-Adapter-Architektur

### 4.1 Topologie

```
Browser                    │ Hypha-Server (Docker, ein Container)                  │ Volume
──────────────────────────────────────────────────────────────────────────────────────────
                           │                                                       │
[Logseq-Web-App-Hypha-Build]│  [hypha-server/    Reverse-Proxy + Statics       ]    │
  ├ React + Rum            │   ├ /            → static/js/* (Hypha-CLJS-Build) │    │
  ├ Web-Worker             │   ├ /sync/...    → http://localhost:8787 (db-sync)│    │
  │  ├ DataScript-Conn     │   ├ /asset/...   → http://localhost:8787          │    │
  │  ├ OPFS+sqlite-wasm    │   ├ /auth/login  → AccessCode → Hypha-JWT         │    │
  │  └ db-sync-Client────┐ │   ├ /auth/session→ Cookie → JWT-Refresh           │    │
  └ Hypha-Login-Modul   │ │   ├ /auth/logout → Cookie löschen                  │    │
                        │ │   └ /auth/jwks   → JWKS (Hypha-Signing-Key)        │    │
                        │ │                                                    │    │
                        │ │  [node-adapter.js  unverändert von deps/db-sync ]  │    │
                        └─→  ├ WS /sync/:graph-id  (Tx-Stream)                 │    │
                            ├ HTTP /sync/...      (Bootstrap, Snapshot)        │    │
                            ├ JWT-Verify gegen Hypha-JWKS (env-konfiguriert)   │    │
                            └ Persistenz ─────────────────────────────────────────→ /data/
                                                                               │     ├ <graph>/db.sqlite
                                                                               │     ├ <graph>/tx-log.sqlite
                                                                               │     ├ <graph>/assets/
                                                                               │     └ sessions.json
```

Drei Prozesse im Container:
1. `hypha-server` (Fastify auf :80)
2. `node-adapter.js` aus `deps/db-sync` (auf localhost:8787, unverändert)
3. Optional: TLS-Frontend (Caddy/Nginx)

### 4.2 Komponenten-Mapping

| Komponente | Sitz | Sprache | Upstream-Berührung |
|---|---|---|---|
| Web-Frontend (Logseq-CLJS-Build) | `/static/js/*` | ClojureScript | Build-Variante via `--config-merge`, keine Patches |
| Hypha-Init-Modul | `src/main/frontend/hypha/init.cljs` | ClojureScript | 0 (eigenes Modul) |
| Hypha-Login-Modal | `src/main/frontend/hypha/login.cljs` | ClojureScript | 0 |
| Hypha-Config | `src/main/frontend/hypha/config.cljs` | ClojureScript | 0 |
| Login-Event-Routing | Cond-Klausel in `handler/events/ui.cljs` | ClojureScript | **Patch #1** |
| App-Init-Hook | Init-Aufruf in `handler.cljs` | ClojureScript | **Patch #2** |
| Hypha-Server | `hypha-server/` | TypeScript | 0 |
| Auth-Issuer | `hypha-server/src/auth/` | TypeScript | 0 |
| Reverse-Proxy | `hypha-server/src/proxy.ts` | TypeScript | 0 |
| Statics-Server | `hypha-server/src/statics.ts` | TypeScript | 0 |
| db-sync-Server | `deps/db-sync/worker/dist/node-adapter.js` | (transpiliertes CLJS) | 0 |
| Dockerfile/Compose | `Dockerfile.hypha`, `docker-compose.hypha.yml` | Docker | 0 |
| Build-Pipeline | `bin/hypha-build` | Bash | 0 |

### 4.3 Patches (Komplettliste)

| # | Datei | Ankerpunkt | Tier | Zeilen |
|---|---|---|---|---|
| 1 | `src/main/frontend/handler/events/ui.cljs` | `defmethod events/handle :user/login` (~Z. 349) | Mini-Hook | +4 |
| 2 | `src/main/frontend/handler.cljs` | nach `(user-handler/restore-tokens-from-localstorage)` (~Z. 160) | Mini-Hook | +2 |

Beide siehe Patch-Inventar in Abschnitt 10.

### 4.4 Hypha-CLJS-Module

`src/main/frontend/hypha/`:

| Datei | Zweck |
|---|---|
| `config.cljs` | `(goog-define HYPHA-MODE false)` + `hypha-mode?` |
| `init.cljs` | App-Bootstrap: `/auth/session`, Sync-URL-Setzung, Auto-Login bei gültigem Cookie |
| `login.cljs` | AccessCode-Modal, POST `/auth/login`, JWT in state speichern |
| `events.cljs` | (vakant für Phase 1, falls weitere Hypha-Events nötig werden) |

### 4.5 Hypha-Server (TypeScript)

`hypha-server/`:

```
hypha-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts            (Entry: Fastify + db-sync-runner spawnen + Routes)
│   ├── config.ts          (Env-Var-Parsing: HYPHA_DATA_DIR, HYPHA_ACCESS_CODE_HASH, ...)
│   ├── auth/
│   │   ├── access-code.ts (bcrypt-Verify gegen env)
│   │   ├── jwt.ts         (RS256-Sign mit jose)
│   │   ├── jwks.ts        (JWKS-Endpoint)
│   │   └── session.ts     (In-Memory-Session-Store + Cookie-Helpers)
│   ├── proxy.ts           (fastify-http-proxy zu localhost:8787, WS+HTTP)
│   ├── statics.ts         (Static-Serving für /static/js/*)
│   ├── db-sync-runner.ts  (Child-Process für node-adapter.js)
│   └── routes/
│       ├── login.ts
│       ├── session.ts
│       ├── logout.ts
│       └── health.ts
└── test/
```

### 4.6 Auth-Flow

```
Schritt 1 — Login
  Browser           Hypha-Server
    │                   │
    ├ POST /auth/login ─►│  AccessCode-Verify (bcrypt gegen HYPHA_ACCESS_CODE_HASH)
    │  { code: "..." }   │  → Hypha-JWT (RS256, 30 Tage) signieren
    │                   │
    │◄── 200 ────────────┤  Set-Cookie: hypha-session=<opaque-id>;
    │                   │              HttpOnly; Secure; SameSite=Strict;
    │                   │              Max-Age=2592000
    │                   │  Body: { id-token: "<JWT>" }
    │                   │
    ├ hypha-login.cljs liest Body,
    │  ruft state/set-auth-id-token
    │ (JWT im JS-Speicher, NICHT in localStorage)

Schritt 2 — Page Reload
  Browser           Hypha-Server
    │                   │
    ├ hypha-init/start! ►│
    │  GET /auth/session │  Cookie-Auth-Check
    │  (Cookie mitsendet)│  Wenn Cookie gültig: frisches JWT signieren
    │                   │
    │◄── 200 ────────────┤  Body: { id-token: "<JWT>" }
    │                   │
    ├ state/set-auth-id-token
    │
    │ (oder 401 → state/pub-event! [:user/login])

Schritt 3 — Sync-Operation (WS)
  Browser → WS /sync/:graph-id?token=<JWT>
                 ↑
                 JWT aus state/get-auth-id-token

Schritt 4 — HTTP-API-Operation
  Browser → fetch /sync/...
            Authorization: Bearer <JWT>
                                  ↑
                                  state/get-auth-id-token
```

### 4.7 Hypha-JWT-Format (locked in via V1-(c))

```typescript
// hypha-server/src/auth/jwt.ts
async function signHyphaJwt(username: string): Promise<string> {
  return await new SignJWT({
    sub:                  "hypha-user",
    "cognito:username":   username,    // Defensiver Doppel-Claim
    "preferred_username": username,    // Defensiver Doppel-Claim
    email:                hyphaConfig.userEmail ?? "user@hypha.local",
    name:                 username,
  })
    .setProtectedHeader({ alg: "RS256", kid: hyphaConfig.signingKid })
    .setIssuer(hyphaConfig.jwtIssuer)
    .setAudience(hyphaConfig.jwtAudience)
    .setExpirationTime("30d")
    .sign(hyphaConfig.signingPrivateKey);
}
```

**Constraints abgeleitet aus deps/common `verify-jwt`:**
- Algorithm RS256 (RSASSA-PKCS1-v1_5, SHA-256)
- `iss` muss `HYPHA_JWT_ISSUER` (intern als `COGNITO_ISSUER` zu db-sync) entsprechen
- `aud` (oder `client_id`) muss `HYPHA_JWT_AUDIENCE` entsprechen
- `exp` muss in der Zukunft liegen
- JWKS-Endpoint serve den Public-Key mit passendem `kid`

**Env-Var-Übersetzung in `hypha-server`:**
- `HYPHA_JWT_ISSUER` → setze intern als `COGNITO_ISSUER` vor `node-adapter.js`-Spawn
- `HYPHA_JWT_AUDIENCE` → setze intern als `COGNITO_CLIENT_ID`
- `HYPHA_JWT_JWKS_URL` → setze intern als `COGNITO_JWKS_URL`

### 4.8 Build-Flag-Strategie

```bash
clojure -M:cljs release app db-worker \
  --config-merge '{:closure-defines {frontend.hypha.config/HYPHA-MODE true}}'
```

`shadow-cljs.edn` bleibt unangetastet. Empirisch verifiziert in V4.

---

## 5. Verifikationen V1–V4

### V1 — `deps/db-sync` Cognito-Agnostizität

**Befund:** strukturell agnostisch, Naming irreführend.

| Treffer | Ort | Kategorie | Konsequenz |
|---|---|---|---|
| `COGNITO_ISSUER/CLIENT_ID/JWKS_URL` | `node/config.cljs`, `node/graph.cljs`, `node/server.cljs` | reine Config-Namen | Env-Var-Übersetzung in `hypha-server` |
| `verify-jwt` | `deps/common/.../authorization.cljs:87–126` | standard RS256/JWKS-Verifikation | 0 Patches; Hypha-JWTs müssen RS256 sein |
| `aget claims "cognito:username"` in `presence.cljs:11` | Presence-Display | mit Fallback auf `preferred_username` und `username` | 0 Patches |
| `aget claims "cognito:username"` in `index.cljs:340` | DB-Spalte `users.username` | ohne Fallback | V1-(c)-Auflösung: JWT enthält beide Claims identisch |

**Verdict:** 0 zusätzliche Patches. Hypha-JWT-Format-Constraints siehe 4.7.

### V2 — Refresh-Token-Guard

**Befund:** Guard hält. `<refresh-id-token&access-token` (`handler/user.cljs:195–230`) ist ein reines `(go (when-let [refresh-token …] …body…))`. Body ist die einzige Anweisung im `go`.

Nachbarn:
- `restore-tokens-from-localstorage` (Z. 232–263) verlangt alle drei Tokens, macht ohne refresh-token nichts. Hypha-Init übernimmt Restoration eigenständig.
- `<ensure-id&access-token` / `task--ensure-id&access-token` (Z. 326–347) wird vor jeder db-sync-Operation aufgerufen. Bei langlebigem Hypha-JWT durchläuft das so:
  - Tag 0 bis 29.96: `almost-expired?` false → kein Refresh-Call
  - Letzte Stunde: Refresh-Call läuft, ist no-op, Token gültig → kein Fehler
  - Nach Expiry: `task--ensure-id&access-token` wirft `ex-info {:type :expired-token}`

**Konsequenz:** Hypha-Frontend muss `:expired-token`-Exception abfangen und Re-Login triggern. Pure Hypha-Code in `src/main/frontend/hypha/events.cljs`, **0 zusätzliche Upstream-Patches**.

### V3 — Cookie/JS-Token-Inkonsistenz (gelöst)

Ursprüngliche Skizze hatte logischen Bruch: HttpOnly + JS-`read-hypha-cookie` ist unmöglich.

**Korrigiertes Design:** HttpOnly-Session-Cookie + `/auth/session`-Endpoint + JWT-im-JS-Speicher (nicht in localStorage). WS-Auth via Query-Token bleibt möglich, weil JWT in JS verfügbar ist.

Siehe 4.6 für vollständigen Flow.

**Konsequenz:** 0 zusätzliche Upstream-Patches; Design-Korrektur ist in `hypha-server` + `hypha-init/start!` aufgehoben.

### V4 — `--config-merge` mit `:closure-defines`

**Empirisch verifiziert am 2026-05-27.** Ablauf:

1. `pnpm install --ignore-scripts` (15.8s)
2. Temporärer `(goog-define HYPHA-MERGE-TEST false)` an `config.cljs` angehängt
3. `clojure -M:cljs compile app --config-merge '{:closure-defines {frontend.config/HYPHA-MERGE-TEST true}}'` (28.88s)
4. Ergebnis in `static/js/main.js:4`:
   ```javascript
   var CLOSURE_DEFINES = {
     "frontend.config.HYPHA_MERGE_TEST": true,     // ← merge-in
     "frontend.config.ENABLE_DB_SYNC_LOCAL": false,
     "frontend.config.ENABLE_PLUGINS": true,
     ...
   };
   ```
5. `git checkout -- src/main/frontend/config.cljs` (sauber)

**Verdict:** Pattern für `:app`-Build bestätigt. Fallback-Pfad (separate `shadow-cljs.hypha.edn`) **nicht nötig**.

---

## 6. Annahmenkatalog

| ID | Annahme | Quelle | Verifiziert |
|---|---|---|---|
| A1 | Patch #1: `:user/login`-Multimethod-Dispatch ist stabil; cond-Klausel funktioniert | Punkt 4 | M1 |
| A2 | Patch #2: `handler.cljs:160`-Init-Punkt ist korrekt; `hypha-init/start!` integriert | Punkt 4 | M1 |
| A3 | `hypha-server` als transparenter WS+HTTP-Proxy zu `node-adapter.js` funktioniert | Punkt 4 | M2 |
| A4 | Hypha-RS256-JWTs mit V1-(c)-Claims passieren `verify-jwt` in deps/common | V1 | M2 (Laufzeit) |
| A5 | `localStorage.sync-server-url = window.origin` lenkt db-sync-Client auf Hypha-Endpoint | Punkt 1 | M2 |
| A6 | WS-Auth via `?token=<jwt>` Query-Param funktioniert durch Hypha-Proxy hindurch | V3 | M2 |
| A7 | HttpOnly-Cookie + `/auth/session` + JWT-im-Speicher ist umsetzbar | V3 | M1 |
| A8 | `--config-merge` mit `:closure-defines` propagiert für `:app`-Build | V4 | **Ja** (vor Phase 1) |

---

## 7. Meilensteinplan

### M0 — Build-Skeleton

**Scope:** Hypha-Build-Pipeline aufstellen, Top-Level-Verzeichnisse anlegen, hypha-server Hello-World.

**Upstream-Dateien:** 0

**Hypha-Dateien neu:**
- `src/main/frontend/hypha/config.cljs` (`(goog-define HYPHA-MODE false)` + `hypha-mode?`)
- `src/main/frontend/hypha/init.cljs` (`(defn start! [])` leer)
- `hypha-server/package.json` (TS-Deps: fastify, fastify-http-proxy, jose)
- `hypha-server/tsconfig.json`
- `hypha-server/src/main.ts` (Hello-World, `/health` → 200)
- `bin/hypha-build`

**Verifiziert / nutzt Annahme:** A8 — V4 war manuell (Chat-Test 2026-05-27). M0 reproduziert das Pattern in der CI-fähigen Build-Pipeline, sodass `--config-merge`-Propagation pro Build verifizierbar bleibt.

**Warum vor M1 nötig:** M1 braucht funktionierende Build-Infrastruktur. M0 ist Voraussetzung, **und** trägt die wiederkehrende A8-Verifikation.

**DoD:**
- `bin/hypha-build` produziert `static/js/main.js` mit `"frontend.hypha.config.HYPHA_MODE":true` im `CLOSURE_DEFINES`
- `pnpm --dir hypha-server start` läuft, `curl localhost:80/health` → 200
- `bb dev:lint-and-test` weiterhin grün
- `git status` zeigt nur neue Hypha-Dateien

**Dauer:** 0.5–1 Tag

### M1 — Login-Spike + V3-Verifikation

**Scope:** End-to-end Auth-Flow Browser ↔ Hypha-Server. Beide Upstream-Patches landen hier.

**Upstream-Dateien:** 2 (=Phase-1-Budget)
- `src/main/frontend/handler/events/ui.cljs` (Patch #1)
- `src/main/frontend/handler.cljs` (Patch #2)

**Hypha-Dateien neu:**
- `src/main/frontend/hypha/login.cljs` (AccessCode-Modal)
- `src/main/frontend/hypha/init.cljs` (gefüllt)
- `hypha-server/src/auth/access-code.ts`
- `hypha-server/src/auth/jwt.ts`
- `hypha-server/src/auth/jwks.ts`
- `hypha-server/src/auth/session.ts`
- `hypha-server/src/routes/login.ts`
- `hypha-server/src/routes/session.ts`
- `HYPHA_PATCHES.md` (erste zwei Einträge)

**Verifiziert / nutzt Annahme:** A1, A2, A7

**DoD:**
- Frischer Browser → `http://localhost` → Hypha-Login-Modal (nicht Cognito-Modal)
- AccessCode korrekt → 200, Cookie gesetzt, JWT in `(state/get-auth-id-token)`
- F5 → Hypha-Login-Modal erscheint nicht erneut, JWT wieder in state (via `/auth/session`)
- Cookie manuell gelöscht + F5 → Hypha-Login-Modal erneut
- AccessCode falsch → 401
- `bb dev:lint-and-test` grün

**Dauer:** 1–2 Tage

### M2 — DB-Sync-Anbindung

**Scope:** hypha-server spawnt `node-adapter.js`, Reverse-Proxy für `/sync/*`, authentifizierte WS+HTTP-Calls.

**Upstream-Dateien:** 0

**Hypha-Dateien neu:**
- `hypha-server/src/db-sync-runner.ts`
- `hypha-server/src/proxy.ts`
- `hypha-server/src/main.ts` (erweitert)
- `bin/hypha-build` (erweitert: baut `pnpm --dir deps/db-sync build:node-adapter`)

**Verifiziert / nutzt Annahme:** A3, A4, A5, A6

**DoD:**
- `pnpm --dir hypha-server start` → node-adapter läuft als Child-Process
- Browser-Konsole: Tx-Round-Trip funktioniert
- Browser-Network-Tab: WS auf `wss://localhost/sync/<graph-id>?token=<jwt>` öffnet
- Hypha-Server-Logs zeigen `verify-jwt`-Success
- Falscher JWT → WS-Close mit klarer Begründung

**Dauer:** 1–2 Tage

### M3 — Volume-Persistenz

**Scope:** Dockerized Build, Bind-Mount `/data`, Edit-Restart-Edit-Roundtrip.

**Upstream-Dateien:** 0

**Hypha-Dateien neu:**
- `Dockerfile.hypha` (Multi-Stage)
- `docker-compose.hypha.yml` (v1)
- `docs/hypha/operations.md` (Start)

**Verifiziert / nutzt Annahme:** keine neue; Integrationstest A3+A4+A6

**DoD:**
- `docker compose -f docker-compose.hypha.yml up --build` → Container läuft
- Browser → Hypha-Login → Blöcke + Page-Referenz erstellen
- `docker compose restart`
- Browser-Reload → Daten persistent
- `ls -la <volume>/` zeigt `db.sqlite`, `tx-log.sqlite`, `assets/`, `sessions.json`
- Permissions sauber

**Dauer:** 1 Tag

### M4 — Distro-Polish

**Scope:** Doku, Operator-UX, Hypha-CI.

**Upstream-Dateien:** 0

**Hypha-Dateien neu:**
- `docs/hypha/architecture.md` (aus diesem Plan extrahiert)
- `docs/hypha/self-hosting.md`
- `docs/hypha/troubleshooting.md`
- `docker-compose.hypha.yml` (erweitert)
- `hypha-server/src/routes/health.ts` (erweitert)
- `hypha-server/test/headless-auth.spec.ts` (Playwright-Smoke-Test, siehe unten)
- `.github/workflows/hypha-build.yml`

**Verifiziert / nutzt Annahme:** keine neuen, aber: prophylaktische Erweiterung des Smoke-Build-Schutzes für die wöchentliche Upstream-Sync-Action (siehe Headless-Auth-Smoke-Test unten).

**Headless-Auth-Smoke-Test (prophylaktisch ergänzt):**
Der reine `grep`-Test in der Upstream-Sync-Action (Anhang A) verifiziert nur, dass das Closure-Define propagiert hat. Ein Logseq-Build kann erfolgreich kompilieren und trotzdem im Browser sofort eine `:user/login`-Dispatch-Exception werfen, wenn upstream-Reagent-Logik sich verändert. Der Headless-Auth-Smoke-Test schließt diese Lücke:
- Startet Hypha-Stack (hypha-server + bereits gebaute Statics, ohne node-adapter — der wird via Stub-Endpoint auf `/sync/*` mockiert)
- Playwright-Browser ruft `POST /auth/login` mit Test-AccessCode
- Assertion: 200, `id-token`-Feld im Body ist ein wohlgeformtes JWT (3 base64url-Teile, parsebar, `sub == "hypha-user"`)
- Browser lädt `/` (Hypha-Frontend), wartet auf DOM-Ready, prüft `state/get-auth-id-token` via injected JS gleich gesetzt
- Laufzeit-Budget: < 30 Sekunden
- Erfasst geschätzt 80 % der semantischen Drift, die das `grep` allein nicht sieht

**DoD:**
- Dritte Person kann Hypha nach `docs/hypha/self-hosting.md` aufsetzen
- Hypha-CI baut Distro + M3-Smoke-Test headless
- Headless-Auth-Smoke-Test grün gegen frischen Hypha-Build
- Wöchentliche Upstream-Sync-Action (Anhang A) ruft den Headless-Auth-Smoke-Test nach dem `grep`-Test (siehe aktualisierte YAML)
- `bb dev:lint-and-test` grün
- `HYPHA_PATCHES.md` hat exakt zwei Einträge

**Dauer:** 1–2 Tage

### Zusammenfassung

| ID | Scope | Upstream | Verifiziert | Dauer |
|---|---|---|---|---|
| M0 | Build-Skeleton | 0 | A8 reproduziert | 0.5–1 Tag |
| M1 | Login-Spike + V3 | 2 | A1, A2, A7 | 1–2 Tage |
| M2 | DB-Sync-Anbindung | 0 | A3, A4, A5, A6 | 1–2 Tage |
| M3 | Volume-Persistenz | 0 | (integration) | 1 Tag |
| M4 | Distro-Polish | 0 | (keine) | 1–2 Tage |
| **Σ** | **Phase 1** | **2** | **A1–A8 abgedeckt** | **4.5–8 Tage** |

---

## 8. Upstream-Sync-Strategie

### 8.1 Branch-Layout (git flow + Hypha-Erweiterung)

Hypha verwendet das **Standard-git-flow-Layout** mit zwei Hypha-spezifischen Zusatz-Branches für die Upstream-Sync-Disziplin.

```
origin (teuffel/hypha)
├── master              # Production-Releases (Tags wie v0.1.0)
├── develop             # Aktive Integration; Hypha-Hauptbranch
├── feature/<topic>     # WIP-Feature-Branches, mergen in develop
├── release/<version>   # Release-Vorbereitung, von develop → master
├── hotfix/<topic>      # Notfall-Fixes von master → master + develop
├── upstream-master     # 1:1-Mirror von logseq/logseq:master (read-only)
└── hypha-staging       # Wöchentlicher Upstream-Sync-Test-Branch

upstream (logseq/logseq)
└── master
```

**Beziehungen:**
- `master` ist Production. Nur Release-Branches und Hotfixes mergen direkt rein.
- `develop` ist das aktive Integrationsziel. Hier landen Features, hier landet auch die Upstream-Sync.
- `feature/<topic>`-Branches werden via `git flow feature start <topic>` erstellt, gehen via PR oder `git flow feature finish` zurück in `develop`.
- `upstream-master` wird wöchentlich gefetcht und force-pushed (read-only Spiegel des Upstream-Stands).
- `hypha-staging` ist Inspektions-Branch der wöchentlichen Action. Bei Erfolg: PR gegen **`develop`** (nicht master). Bei Konflikt: Branch bleibt zur manuellen Diagnose stehen.
- Releases laufen via `git flow release start <version>` von `develop` aus, finishen nach `master`.

**Begründung gegen direkten Upstream-Sync nach master:** Upstream-Änderungen sind „next release"-Material, kein Hotfix. Sie gehören in `develop`, durchlaufen Stabilisierung, und gehen via Release-Branch nach `master`.

**git-flow Setup-Status:** initial konfiguriert mit `git flow init -d` (Standard-Defaults: master/develop, Prefixes `feature/`, `bugfix/`, `release/`, `hotfix/`, `support/`, kein Version-Tag-Prefix).

### 8.2 GitHub-Action

Volle YAML in Anhang A. Logik:
- Wöchentlich Mo 06:00 UTC (cron)
- Mirror `upstream-master`
- Test-Merge auf `hypha-staging` (basierend auf `develop`)
- Patch-Anchor-Checks (Anhang B)
- Closure-Define-Smoke-Build (replay V4)
- **Headless-Auth-Smoke-Test** (Runtime-Verifikation via Playwright, fängt semantische Drift, die der Closure-Define-Test nicht sieht)
- Bei vollem Erfolg: automatische PR gegen **`develop`** (git-flow-konform; nicht direkt nach master)
- Bei Konflikt/Anchor-Fail/Smoke-Fail/Auth-Smoke-Fail: Issue mit Detail-Report

### 8.3 `HYPHA_PATCHES.md`

Format mit Pflichtfeldern (Vollvorlage in Anhang C):
- ID, Eingeführt-in-Meilenstein, Datei
- Patch-Form (Original + Hypha-Version)
- Zeilenzahl
- Begründung
- Additive Alternativen geprüft
- Bruchsignal strukturell + semantisch
- Detektion (automatisch + manuell)
- Bei Bruch

### 8.4 Divergenz-Metriken

| Indikator | Schwellenwert | Bedeutung | Reaktion |
|---|---|---|---|
| Einträge in `HYPHA_PATCHES.md` | > 20 | Zu viele Touchpoints im Upstream | Architektur-Review |
| Konflikt-Häufigkeit Sync-Action | > 25 % der Wochen | Patches an Upstream-Hotspots | Patches verschieben oder Anker absichern |
| Anchor-Check-Fails/Quartal | > 1 | Patches verlieren prospektiv Halt | Bruchsignal-Felder verfeinern |
| Smoke-Build-Fails nach Clean-Merge/Quartal | > 1 | Stille Semantik-Drift | Spezifischere Smoke-Tests |
| Einzelner Patch | > 10 Zeilen | Kein Mini-Hook mehr | Refaktorieren, additive Alternative suchen |
| Zeit pro Konflikt-Auflösung | > 30 min Mittel | Patch zu nah an aktivem Upstream | Patch verschieben |

**Roter Faden:** Patches sind Diagnose-Instrument. Bei häufigem Brechen/Wachsen: Hypha-Architektur eine Stelle früher anders ansetzen.

### 8.5 Hypha-Server-Deps-Disziplin

Die wöchentliche Upstream-Sync-Action (8.2) deckt **Logseq-Upstream** ab, nicht aber Hypha-eigene npm-Dependencies (`hypha-server/package.json`: fastify, jose, fastify-http-proxy, etc.). Diese brauchen eigene Update-Disziplin, insbesondere für Security-Patches (jose ist Krypto-Code, fastify hat Network-Surface).

**Mechanismus**: GitHub Dependabot für `hypha-server/package.json`, monatliche Frequenz.

| Update-Typ | Behandlung |
|---|---|
| Patch-Bumps (x.y.**Z**) | Auto-Merge wenn CI grün — fällt in die hochautomatisierbare Klasse |
| Minor-Bumps (x.**Y**.z) für `jose`, `fastify` | Auto-Merge wenn CI grün, weil Security-relevant |
| Minor-Bumps für `fastify-http-proxy` | Manueller Review (Proxy-Verhalten ändert sich subtil) |
| Major-Bumps (**X**.y.z) | Immer manueller Review; API-Bruchpotential |
| `@types/*`-Packages | Auto-Merge wenn CI grün |

**Konfigurations-Artefakt** (entsteht in M0 zusammen mit `hypha-server/package.json`):

```yaml
# .github/dependabot.yml (auszubauen in M0)
version: 2
updates:
  - package-ecosystem: npm
    directory: /hypha-server
    schedule:
      interval: monthly
    open-pull-requests-limit: 5
    labels: [hypha-deps]
    groups:
      jose-fastify-security:
        patterns: [jose, fastify, "@fastify/*"]
        update-types: [patch, minor]
      types:
        patterns: ["@types/*"]
    ignore:
      # Major bumps require manual review — keep dependabot out of them
      - dependency-name: fastify
        update-types: [version-update:semver-major]
      - dependency-name: fastify-http-proxy
        update-types: [version-update:semver-major, version-update:semver-minor]
```

Die `pnpm-lock.yaml` in `hypha-server/` muss vorhanden sein, sobald `hypha-server/package.json` existiert (entsteht in M0), damit Dependabot reproduzierbare Updates produziert.

**Aufnahme-Zeitpunkt**: nicht relevant für M0–M4 funktional, aber `.github/dependabot.yml` sollte zusammen mit dem ersten `hypha-server/package.json`-Commit in M0 angelegt werden. Damit greift die Disziplin ab dem ersten Tag.

---

## 9. Anhang A — GitHub-Action `upstream-sync.yml`

```yaml
name: Upstream Sync (weekly)

on:
  schedule:
    - cron: '0 6 * * 1'      # Mo 06:00 UTC
  workflow_dispatch: {}

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: develop
          fetch-depth: 0

      - name: Configure git + upstream remote
        run: |
          git remote add upstream https://github.com/logseq/logseq.git
          git fetch upstream master
          git config user.name  "hypha-sync-bot"
          git config user.email "sync-bot@hypha.local"

      - name: Mirror upstream-master
        run: |
          git push origin refs/remotes/upstream/master:refs/heads/upstream-master --force

      - name: Recreate hypha-staging
        run: |
          git checkout develop
          git branch -D hypha-staging || true
          git checkout -b hypha-staging

      - name: Attempt merge
        id: merge
        run: |
          if git merge upstream/master --no-edit; then
            echo "result=clean" >> $GITHUB_OUTPUT
          else
            echo "result=conflict" >> $GITHUB_OUTPUT
            CONFLICTS=$(git diff --name-only --diff-filter=U)
            echo "conflicts<<EOF" >> $GITHUB_OUTPUT
            echo "$CONFLICTS" >> $GITHUB_OUTPUT
            echo "EOF" >> $GITHUB_OUTPUT
            git merge --abort
          fi

      - name: Patch-Anchor-Checks
        if: steps.merge.outputs.result == 'clean'
        id: anchors
        run: |
          bash .github/scripts/hypha-patch-anchors.sh > anchor-report.txt
          if grep -q "FAIL" anchor-report.txt; then
            echo "result=fail" >> $GITHUB_OUTPUT
          else
            echo "result=pass" >> $GITHUB_OUTPUT
          fi

      - name: Smoke-Build (Closure-Define-Propagation)
        if: steps.merge.outputs.result == 'clean' && steps.anchors.outputs.result == 'pass'
        id: smoke
        run: |
          # Toolchain-Setup wie .github/workflows/build.yml
          pnpm install --frozen-lockfile --ignore-scripts
          clojure -M:cljs compile app \
            --config-merge '{:closure-defines {frontend.hypha.config/HYPHA-MODE true}}'
          if grep -q '"frontend.hypha.config.HYPHA_MODE":true' static/js/main.js; then
            echo "result=pass" >> $GITHUB_OUTPUT
          else
            echo "result=fail" >> $GITHUB_OUTPUT
          fi

      - name: Headless-Auth-Smoke-Test (Runtime-Verifikation)
        if: steps.smoke.outputs.result == 'pass'
        id: auth_smoke
        run: |
          # Verifiziert, dass Hypha-Stack zur Laufzeit kommt und der Auth-Flow
          # nicht durch semantische Upstream-Drift gebrochen wurde.
          # Spec lebt in hypha-server/test/headless-auth.spec.ts (siehe M4).
          pnpm --dir hypha-server install --frozen-lockfile
          pnpm --dir hypha-server build
          # Test startet hypha-server intern (mit Stub-Proxy für /sync/*),
          # ruft /auth/login + verifiziert JWT-Form. Timeout 60s.
          if timeout 60 pnpm --dir hypha-server test:headless-auth; then
            echo "result=pass" >> $GITHUB_OUTPUT
          else
            echo "result=fail" >> $GITHUB_OUTPUT
          fi

      - name: Push + PR on full success
        if: steps.merge.outputs.result == 'clean'
              && steps.anchors.outputs.result == 'pass'
              && steps.smoke.outputs.result == 'pass'
              && steps.auth_smoke.outputs.result == 'pass'
        run: |
          git push origin hypha-staging --force
          gh pr create \
            --base develop \
            --head hypha-staging \
            --title "Weekly upstream sync — $(date +%Y-%m-%d)" \
            --body "Automatic merge of upstream/master into develop.
              - Merge:                 clean
              - Patch anchors:         pass
              - Closure-Define build:  pass
              - Headless-Auth smoke:   pass

              Review for semantic changes before merging."
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Open issue on any failure
        if: steps.merge.outputs.result == 'conflict'
              || steps.anchors.outputs.result == 'fail'
              || steps.smoke.outputs.result == 'fail'
              || steps.auth_smoke.outputs.result == 'fail'
        run: |
          {
            echo "## Upstream sync needs attention — $(date +%Y-%m-%d)"
            echo
            echo "### Merge result"
            echo "${{ steps.merge.outputs.result }}"
            echo
            echo "### Conflicted files"
            echo '```'
            echo "${{ steps.merge.outputs.conflicts }}"
            echo '```'
            echo
            echo "### Patch-Anchor-Report"
            echo '```'
            cat anchor-report.txt 2>/dev/null || echo "(not run — merge conflict)"
            echo '```'
            echo
            echo "### Closure-Define-Smoke"
            echo "${{ steps.smoke.outputs.result }}"
            echo
            echo "### Headless-Auth-Smoke"
            echo "${{ steps.auth_smoke.outputs.result }}"
            echo
            echo "### Last 10 upstream commits"
            echo '```'
            git log --oneline upstream/master ^develop | head -10
            echo '```'
            echo
            echo "### Action-Run"
            echo "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          } > issue-body.md
          gh issue create \
            --title "Upstream sync needs attention — $(date +%Y-%m-%d)" \
            --label "upstream-sync,needs-triage" \
            --body-file issue-body.md
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 10. Anhang B — Anchor-Check-Script `.github/scripts/hypha-patch-anchors.sh`

```bash
#!/usr/bin/env bash
# Prüft pro Patch in HYPHA_PATCHES.md, ob der Ankerpunkt noch existiert.

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

# Neue Patches → neue check-Aufrufe hier ergänzen (parallel zum HYPHA_PATCHES.md-Eintrag)

exit $exit_code
```

---

## 11. Anhang C — `HYPHA_PATCHES.md` Vollvorlage (Stand vor M1)

```markdown
# HYPHA_PATCHES.md

Inventur aller Stellen, an denen Hypha bestehenden Logseq-Upstream-Code modifiziert.

Reihenfolge: chronologisch (ältester Patch zuerst).
Schwellenwert: > 20 Einträge ⇒ Architektur-Smell, Refaktorisierung der Hypha-Eingriffsstrategie auslösen.

---

## Patch #1 — Login-Routing für Hypha-Modus

- **ID**: HYPHA-PATCH-001
- **Eingeführt**: Meilenstein 1 (Login-Spike), `<YYYY-MM-DD>`, commit `<sha>`
- **Datei**: `src/main/frontend/handler/events/ui.cljs`
- **Patch-Form**:
  ```clojure
  ;; ORIGINAL (~Z. 349)
  (defmethod events/handle :user/login [[_]]
    (if (mobile?)
      (route-handler/redirect! {:to :user-login})
      (login/open-login-modal!)))

  ;; HYPHA
  (defmethod events/handle :user/login [[_]]
    (cond
      hypha-config/hypha-mode?
      (hypha-login/open-login-modal!)

      (mobile?)
      (route-handler/redirect! {:to :user-login})

      :else
      (login/open-login-modal!)))
  ```
  plus zwei `:require`-Einträge am Datei-Anfang:
  `[frontend.hypha.config :as hypha-config]`, `[frontend.hypha.login :as hypha-login]`
- **Zeilenzahl**: +4 (cond-Klausel + if→cond Umstellung)
- **Begründung**: Im Hypha-Modus den Hypha-AccessCode-Login statt Cognito-Login öffnen. Alle Aufrufer (`components/settings.cljs`, `components/header.cljs`) bleiben unverändert — der eine Dispatcher entscheidet.
- **Additive Alternativen geprüft**:
  - Multimethod-Override aus Hypha-Modul: verworfen (Load-Order-Fragilität bei Hot-Reload)
  - Aufrufer-Patching: verworfen (4 Patches statt 1)
  - Event-Hijacking via Wrapper: verworfen (invasiver)
- **Bruchsignal — strukturell**:
  - `defmethod events/handle :user/login` wird umbenannt, gelöscht, oder die Datei verschwindet/splittet
- **Bruchsignal — semantisch**:
  - Cond-Reihenfolge ändert sich; neuer Branch landet vor `hypha-mode?` und überschattet ihn
  - `:user/login`-Event wird durch ein neues Event-Schema ersetzt
- **Detektion**:
  - Strukturell, automatisch:
    `rg -c 'defmethod events/handle :user/login' src/main/frontend/handler/events/ui.cljs` ⇒ `1`
  - Semantisch, manuell beim Triage: erste Klausel im `cond` muss `hypha-mode?` sein
- **Bei Bruch**:
  - Strukturell → neue Dispatcher-Stelle suchen, Patch dort neu setzen, HYPHA_PATCHES.md aktualisieren
  - Semantisch → cond-Reihenfolge fixen oder Event-Schema-Anpassung in `hypha-login`

---

## Patch #2 — Hypha-Init beim App-Start

- **ID**: HYPHA-PATCH-002
- **Eingeführt**: Meilenstein 1 (Login-Spike), `<YYYY-MM-DD>`, commit `<sha>`
- **Datei**: `src/main/frontend/handler.cljs`
- **Patch-Form**:
  ```clojure
  ;; ORIGINAL (~Z. 160, in App-Init-Sequenz)
  (user-handler/restore-tokens-from-localstorage)

  ;; HYPHA
  (user-handler/restore-tokens-from-localstorage)
  (when hypha-config/hypha-mode?
    (hypha-init/start!))
  ```
  plus zwei `:require`-Einträge:
  `[frontend.hypha.config :as hypha-config]`, `[frontend.hypha.init :as hypha-init]`
- **Zeilenzahl**: +2
- **Begründung**: Hypha-Init muss nach `state/state`-Initialisierung (via `restore-tokens-from-localstorage`) und vor erstem Event-Pub laufen. Sie holt JWT via `/auth/session` und setzt `localStorage.sync-server-url`.
- **Additive Alternative geprüft**: `<script>`-Injection in `index.html` (0-Patch-Variante) — verworfen weil HTML + CLJS denselben State doppelt manipulieren würden.
- **Bruchsignal — strukturell**:
  - `restore-tokens-from-localstorage` wird aus `handler.cljs` herausgezogen oder umbenannt
- **Bruchsignal — semantisch**:
  - Init-Sequenz wird umgebaut; unser `(when hypha-mode? (hypha-init/start!))` landet nach erstem Event-Pub oder vor State-Init
- **Detektion**:
  - Strukturell, automatisch:
    `rg -c 'user-handler/restore-tokens-from-localstorage' src/main/frontend/handler.cljs` ⇒ `1`
  - Semantisch, manuell: Hypha-Klausel muss direkt nach `restore-tokens-from-localstorage` stehen
- **Bei Bruch**:
  - Strukturell → neuen Init-Punkt finden, Patch dort setzen
  - Semantisch → Position fixen oder Patch in einen passenderen Init-Hook verschieben

---

(Bei neuen Patches: dieselbe Struktur. Pflichtfelder: ID, Datei, Patch-Form, Zeilenzahl, Begründung, Additive Alternativen geprüft, Bruchsignal strukturell + semantisch, Detektion, Bei Bruch.)
```

---

## Sign-off-Status

| Aspekt | Stand |
|---|---|
| Architekturbasis | Option A, master, db-sync-Kern |
| Backend-Sprache | TypeScript |
| Auth-Flow | V3 vollständig spezifiziert |
| JWT-Format | RS256, V1-(c): cognito:username + preferred_username identisch |
| Build-Strategie | `--config-merge` (V4-empirisch bestätigt) |
| Patch-Anker | handler/events/ui.cljs (#1), handler.cljs (#2) |
| Patch-Budget | 2 Mini-Hooks, ~6 Zeilen |
| Meilensteine | 5 (M0–M4), jeder verifiziert ≥0 Annahmen |
| Verifikations-Coverage | A1–A8 vollständig, A8 vorab erledigt |
| Sync-Disziplin | Branch-Layout, weekly Action, Anchor-Checks, Smoke-Build |
| Patch-Inventar-Format | mit Bruchsignal und Detektion |
| Divergenz-Metriken | sechs konkrete Schwellenwerte mit Reaktions-Vorgaben |

**Phase 1 implementation-bereit.**
