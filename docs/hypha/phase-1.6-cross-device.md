# Phase 1.6 — Cross-Device Personal Cloud

**Status:** Plan (vor Implementation)
**Vorgänger:** Phase 1.5 (Plugin-Marketplace) — abgeschlossen
**Nachfolger:** Phase 2 (Multi-User + Realtime-Collab)

## 0. Warum Phase 1.6

Phase 1 hat als Versprechen "Single-User-Personal-Cloud" — selbst-gehostet,
Daten leben im eigenen Container, ein Access-Code = Zugriff. Phase 1.5 hat
den Plugin-Marketplace nachgereicht.

Bei beidem ist ein zentrales Versprechen ungelöst geblieben: **Ein-User-Identität,
mehrere Geräte/Browser, dieselben Graphen sichtbar.** Das ist die buchstäbliche
Definition von "Personal Cloud" — sonst wäre es nur "lokales Logseq mit
Login-Wall davor".

Der Use-Case der diese Phase aufgedeckt hat:
> "Ich öffne localhost:3030 in Firefox, lege einen Testgraphen an, mache
> Änderungen. Dann öffne ich localhost:3030 in Chrome, authentifiziere
> mich, erwarte den Testgraphen — er ist aber nicht da."

Vier strukturelle Lücken im aktuellen HEAD-develop verhindern das:

1. **Reverse-Proxy unvollständig:** `hypha-server/src/proxy.ts:26-39` proxied nur
   `/sync/*` und `/asset/*` an den db-sync-Node-Adapter. Aber der Node-Adapter
   (`deps/db-sync/worker/dist/node-adapter.js:2470`) erwartet die Graph-Verwaltung
   unter `/graphs`, `/graphs/*`, `/e2ee` direkt am Root, und Asset-Uploads unter
   `/assets/` (mit s). Der Path-Mismatch macht selbst den "Cloud-Sync-Haken beim
   Anlegen"-Pfad heute kaputt (`POST /graphs` → 404 vom statics-Handler).

2. **Hypha-Init triggert keine Remote-Graph-Liste:** Stock-Logseq dispatcht
   `[:user/fetch-info-and-graphs]` aus `login-callback`. Hypha
   (`src/main/frontend/hypha/init.cljs:57-65`) ruft nur `set-hypha-id-token!`
   auf, sonst nichts. Browser B holt nach Login keine Liste.

3. **`logged-in?` semantisch inkompatibel mit Hypha-Auth-Modell:**
   `src/main/frontend/handler/user.cljs:90-93` prüft ausschließlich
   `state/get-auth-refresh-token`. Hypha hat keinen Refresh-Token (das
   HttpOnly-Session-Cookie ist das langlebige Token, das JWT lebt nur in-memory).
   Daraus folgt: `logged-in?` ist in Hypha **immer false**, und alle UI-Stellen,
   die mit `logged-in?` gegated sind (Toolbar-Cloud-Upload-Icon,
   "Use sync (beta)"-Menüpunkt in der All-Graphs-Page), sind unsichtbar.

4. **UX-Defaults verkehrt herum:** `src/main/frontend/components/repo.cljs:608-609`:
   ```clojure
   [cloud? set-cloud?] (hooks/use-state false)       ; Default OFF
   [graph-e2ee? set-graph-e2ee?] (hooks/use-state true) ; Default ON
   ```
   Für Logseq.com (öffentlicher Service, fremde Cloud) ist das defensiv.
   Für Hypha (eigener Server, eigene Maschine, Personal Cloud als
   Architektur-Hauptzweck) ist es exakt verkehrt herum: Cloud sollte
   default-on (sonst Personal-Cloud-Promise gebrochen), E2EE muss default-off
   (sonst kann Browser B den Private-Key nicht herzaubern und scheitert am
   Download).

## 1. Scope

### 1.1 Phase-1.6-Use-Cases (Gesamtebene)

| Use Case | Beschreibung | Erfüllt in |
|---|---|---|
| **U1** | User erstellt in Browser A einen neuen Graphen — landet automatisch auf dem Server | M9 (Default-Cloud-On) + M8 (`/graphs`-Proxy) |
| **U2** | User editiert einen Block in Browser A — Änderung wird live zum Server gepusht | M8 (`/sync/*` schon da, plus `/assets/`-Fix) |
| **U3** | User öffnet Browser B, gibt denselben Access-Code ein — sieht in der Graph-Liste seine Remote-Graphen ohne weitere Klicks | M9 (Auto-Fetch nach Login) |
| **U4** | User klickt einen Remote-Graphen in Browser B — Snapshot wird heruntergeladen, lokale OPFS bestückt, Sync läuft | M8 (Routes) + M9 (UI-Pfad existiert schon, braucht funktionierende Routes) |
| **U5** | User hat in Phase 1.5 noch einen lokal-only-Graphen — kann ihn jetzt nachträglich hochladen | M9 (`logged-in?`-Fix macht Toolbar-Cloud-Icon sichtbar) |
| **U6** | Asset-Uploads (Bilder, PDFs) funktionieren cross-device | M8 (`/assets/`-Bug-Fix) |
| **U7** | Automatisierter Test verifiziert U1-U4 deterministisch in CI | M10 |

### 1.2 Out-of-Scope (Phase 2)

| Use Case | Phase | Warum nicht 1.6 |
|---|---|---|
| **U20** | Mehrere User auf demselben Graph (Sharing, ACLs) | Phase 2 | Multi-User-Identitätsmodell + Access-Control-DSL fehlt. Hypha-Phase-1 hat nur einen User |
| **U21** | Echtzeit-Cursor / Live-Presence zwischen Browser A und B desselben Users | Phase 2 | RTC-WebSocket-Broadcast-Logik im Node-Adapter müsste Single-User-Multi-Session bewusst unterstützen. Wird gleichzeitig mit Multi-User entworfen |
| **U22** | _Automatisches_ E2EE-Key-Sync zwischen Geräten (Recovery-Phrase oder passwortlose KDF) | Phase 2 | V9 hat aufgedeckt: E2EE-Cross-Device mit User-gewähltem Password funktioniert in Phase 1.6 schon (nach M8+M9). Phase-2-Material ist nur die _automatische_ Variante ohne manuelle Password-Eingabe pro Device |
| **U23** | Auto-Migration aller bestehenden lokal-only-Graphen auf den Server beim ersten Login | Phase 2 | Braucht Konflikt-Resolution (was wenn der Graph-Name bereits auf dem Server existiert?). Phase 1.6 macht es per Klick im Multi-Graph-Picker (U5) |
| **U24** | Mobile-App-Sync (Capacitor) | Phase 2+ | Separate Build-Pipeline, eigener OPFS-Adapter-Layer |
| **U25** | Persistente JWT-Signing-Keys über Container-Restart hinweg | Phase 2 | Phase 1 hat bewusst ephemere Keys (`operations.md:73-77`). Container-Restart heute = User loggt sich neu ein, akzeptabel |

### 1.3 Architektur-Constraints

- **0 zusätzliche Upstream-Patches wenn möglich.** Patches-Inventar steht bei
  2/20. Phase 1.6 bringt 2 neue Patches dazu (siehe §5). Ziel-Endstand: 4/20.
- **Server-Routing-Änderungen sind additive.** Kein bestehender Endpoint
  ändert Semantik. `/health`, `/auth/*`, `/sync/*`, `/plugin-*` bleiben
  unverändert.
- **Default-Verhalten dreht sich um, aber Override bleibt.** Cloud-Default-On
  und E2EE-Default-Off sind UX-Defaults für `new-db-graph-inner`, nicht
  Hard-Gates. Der User kann beide Checkboxen weiterhin frei umschalten.
- **Keine Schema-Migrationen.** Phase 1.6 fasst weder Logseq's DB-Schema noch
  db-sync's D1-Schema an.

## 2. Architekturbasis

### 2.1 Was schon vorhanden ist

| Komponente | Wo | Status |
|---|---|---|
| OPFS-Storage pro Graph | `frontend/worker/platform/browser.cljs:74-77` | Funktioniert |
| RTC-WebSocket-Sync | `frontend/worker/sync.cljs` + `/sync/*` Proxy | Funktioniert für bereits-uploaded-Graphen |
| `<rtc-upload-graph!` | `frontend/handler/db_based/sync.cljs:407` | Funktioniert, aber UI-Trigger versteckt durch `logged-in?` |
| `<rtc-create-graph-and-start-sync!` | `sync.cljs:422` | Funktioniert vom Code her, scheitert in Hypha am fehlenden `/graphs`-Proxy |
| `<get-remote-graphs` | `sync.cljs:306` | Funktioniert vom Code her, scheitert am fehlenden `/graphs`-Proxy |
| `<rtc-download-graph!` | `sync.cljs:274` | Funktioniert für gelistete Remote-Graphen |
| Multi-Graph-Picker mit Remote-Graphen | `components/repo.cljs:427` | UI rendert `:rtc/graphs`-State, wenn er gefüllt ist |
| db-sync-Node-Adapter mit `/graphs`-Routes | `deps/db-sync/worker/dist/node-adapter.js:2470` | Hört auf `127.0.0.1:8787`, routet `/graphs`, `/graphs/*`, `/e2ee`, `/assets/*`, `/sync/*` |

### 2.2 Was strukturell fehlt

```
Browser → hypha-server (Port 3030) → node-adapter (loopback 8787)
            │
            ├── /auth/*           ✓ (Hypha-eigen)
            ├── /plugin-*/*       ✓ (Hypha-eigen)
            ├── /health           ✓ (Hypha-eigen)
            ├── /sync/*  ────────→ proxied (HTTP + WS)
            ├── /asset/*  ───────→ proxied (Singular, BUG: Frontend sendet /assets/, plural)
            ├── /graphs           ✗ FEHLT
            ├── /graphs/*         ✗ FEHLT
            ├── /e2ee/*           ✗ FEHLT
            ├── /admin/*          ✗ FEHLT (single-user evtl. nicht zwingend)
            └── /  ──────────────→ statics (fängt alles Unbekannte ab → 404 für /graphs etc.)
```

Frontend-Erwartung an die Server-Routes (aus `sync.cljs` plus `assets.cljs`):

| Methode | Pfad | Code-Aufrufer | Phase-1.6-Status |
|---|---|---|---|
| GET | `/graphs` | `<get-remote-graphs:313` | wird im M8 freigeschaltet |
| POST | `/graphs` | `<rtc-create-graph!` über Worker | wird im M8 freigeschaltet |
| DELETE | `/graphs/<id>` | `<rtc-delete-graph!:266` | wird im M8 freigeschaltet |
| GET | `/graphs/<id>/access` | RTC-Background-Flows | wird im M8 freigeschaltet |
| GET/POST | `/graphs/<id>/members` | `<rtc-invite-email`, `<rtc-get-users-info` | wird im M8 freigeschaltet (Single-User: trivial-leer, aber routerseitig vorhanden) |
| GET/POST | `/e2ee/user-keys` | RSA-Key-Setup | wird im M8 freigeschaltet (für non-E2EE-Graphen unkritisch, aber Frontend ruft trotzdem an) |
| GET | `/e2ee/user-public-key` | E2EE-Setup | M8 |
| PUT/GET/DELETE | `/assets/<graph-id>/<uuid>` | `worker/sync/assets.cljs:62` | **M8: existierender Path-Mismatch /asset → /assets behoben** |
| GET/POST | `/sync/...` | RTC-Loop | unverändert (schon vorhanden) |

### 2.3 Auth-Modell-Inkompatibilität (Lücke 3 im Detail)

Stock-Logseq nimmt nach Cognito-Login das Refresh-Token aus dem
OAuth-Flow und schreibt es in `localStorage`. Beim Boot lädt
`restore-tokens-from-localstorage` es zurück, daher ist
`(state/get-auth-refresh-token)` truthy → `logged-in?` ist `true`.

Hypha (`src/main/frontend/hypha/init.cljs:33-43`) setzt
ausschließlich `:auth/id-token`. Das HttpOnly-Session-Cookie übernimmt
die Refresh-Funktion (rotiert das JWT bei jedem `GET /auth/session`),
ist aber für JavaScript unsichtbar — was Sicherheits-Sinn ergibt, aber
`logged-in?` blind macht.

Fix-Optionen:

| Option | LoC-Delta | Patch-Kosten | Bemerkung |
|---|---|---|---|
| A — `logged-in?` Hypha-aware: prüfe `(or refresh-token (and hypha-mode? id-token (not expired?)))` | ~5 | Patch #3 (~5 LoC) | Sauberste Variante. Semantik bleibt eindeutig |
| B — Sentinel: Hypha setzt `:auth/refresh-token` auf den String `"hypha-session"` | ~2 | Patch #3 (~2 LoC) | Hacky. Wirkt überall richtig, aber unklar für Code-Reader |
| C — `logged-in?` an State-Existenz von `:auth/id-token` koppeln (Upstream-weit) | ~3 | Patch #3 + Stock-Logseq-Verhalten-Risiko | Berührt Cognito-Mode, kann subtile Regressionen geben |

**Entscheidung im Plan: Option A.** Klarste Semantik, minimaler Blast-Radius
durch explizites `hypha-mode?`-Gate. Plus: explizite Expired-Check, was bei
einer plötzlich abgelaufenen JWT-Session korrektes "ausgeloggt" widerspiegelt.

### 2.4 E2EE-Default-Reverse (Lücke 4 im Detail)

`new-db-graph-inner` setzt `graph-e2ee?` per Default auf `true`. Bei E2EE:
1. Browser A generiert beim ersten Cloud-Graph ein RSA-Schlüsselpaar.
2. Public-Key wird auf den Server hochgeladen.
3. Private-Key bleibt lokal in IndexedDB.
4. Graph-Daten werden mit per-Graph AES-Schlüsseln verschlüsselt, die
   wiederum mit dem RSA-Public-Key des Users (auf dem Server) verschlüsselt
   abgelegt werden.

Browser B startet ohne Private-Key. Auch beim erfolgreichen Login + Listing
ist der Download des Graph-Snapshots nicht entschlüsselbar — der AES-Key
wäre für den User-Public-Key encrypted, aber kein zugänglicher
Private-Key in Browser B.

**Lösungsweg E2EE-Key-Sync:** Recovery-Phrase, Backup-Codes, Pairing-Flow.
Eigenes Designkapitel, gehört in Phase 2 (U22).

**Lösungsweg Phase 1.6:** E2EE-Default in Hypha-Mode auf `false` setzen
(Patch #4). User kann es weiterhin manuell aktivieren, übernimmt damit
aber selbst die Key-Verteilung. Konsistent mit der "Self-Hosting-Personal-Cloud"-Story:
wer dem eigenen Server vertraut, braucht keine clientseitige Verschlüsselung.

## 3. Verifikations-Probes (vor M8)

Vor der Implementation: Annahmen-Probes nach Phase-1-Plan-Vorbild. Jede
Probe ist ein eigener, kurzer manueller oder statischer Test. V7-V9
statisch verifiziert am 2026-05-27 vor M8-Start. V10 läuft nach M9.

### V7 — `/health`-Konflikt verifizieren

**Annahme:** Hypha-Server's `/health`-Route (`app.ts:91-97`) gewinnt gegen
ein eventuell durchgereichtes `/health` zum Node-Adapter, weil Fastify-Routes
Priorität haben über Catch-All-Statics.

**Probe (statisch):** `hypha-server/test/proxy.test.ts:158-170` enthält
bereits den Test:
```typescript
test("/auth/* — auth endpoints are NOT proxied, /sync prefix is", async () => {
  ...
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 0, "upstream must not see /health");
});
```

**Ergebnis: ✅ verifiziert.** Existierender Test ist Teil der 39/40 grünen
Hypha-Server-Unit-Tests. `/health` als exact-route gewinnt gegen
`@fastify/http-proxy` (Prefix-Match) und gegen `@fastify/static` (Catch-All).
Phase-1.6-Routes `/graphs`, `/e2ee`, `/assets` folgen demselben
Prefix-Match-Pattern wie heute `/sync` und `/asset` und werden den
existierenden auth-Routes nicht in die Quere kommen.

**Implikation:** M8 kann die drei zusätzlichen Routen via
`fastifyHttpProxy` mit ihren jeweiligen Prefixen registrieren ohne
Spezial-Routing.

### V8 — Asset-Path-Mismatch reproduzieren

**Annahme:** Asset-Sync ist in Phase 1.5 schon broken, weil Frontend
`/assets/` (plural) und Hypha-Server `/asset/` (singular) routet.

**Probe (statisch):**

| Komponente | Pfad-Konvention | Code-Beleg |
|---|---|---|
| Frontend baut URL | `/assets/<graph-id>/<asset-uuid>.<type>` | `src/main/frontend/worker/sync/large_title.cljs:60-62` |
| Node-Adapter routet | `(string/starts-with? path "/assets/")` | `deps/db-sync/src/logseq/db_sync/node/dispatch.cljs:38` und `worker/dispatch.cljs:86` |
| Adapter-Handler erwartet | `(let [prefix "/assets/"]` | `deps/db-sync/src/logseq/db_sync/worker/handler/assets.cljs:94` |
| Hypha-Server proxied | `prefix: "/asset"` (singular!) | `hypha-server/src/proxy.ts:36` |

**Ergebnis: ✅ verifiziert.** Der Mismatch ist real und kommt aus
Phase-1-M2 — `proxy.ts:36` wurde nie gegen einen echten Asset-Upload
verifiziert. Asset-Uploads vom Browser landen auf `localhost:3030/assets/...`,
hypha-server's Static-Handler antwortet 404, der db-sync-Adapter sieht
nie einen Asset-Request.

**Implikation:** M8 ersetzt `/asset` durch `/assets` (Plural). Beibehalten
der singular-Variante ist nicht nötig — kein Code-Pfad konsumiert sie.
Existierender `proxy.test.ts:141-156` Test für `/asset/*` muss zu
`/assets/*` aktualisiert werden (existierender Test wird so von "deckt
ein nicht-genutztes Routing ab" zu "deckt das tatsächlich genutzte
Routing ab" umgebaut).

### V9 — RSA-Key-Verhalten zwischen Browsern

**Annahme:** `<get-remote-graphs:316` ruft `<ensure-user-rsa-keys-on-server!`
unkonditioniert. Wenn der User noch keine Keys hat, werden welche generiert.
Browser B würde dann andere Keys generieren als Browser A → Konflikt auf
`/e2ee/user-public-key`.

**Probe (statisch):** Drei zusammenhängende Code-Stellen:

1. Server-Side bei `GET /graphs`
   (`deps/db-sync/src/.../worker/handler/index.cljs:93-103`):
   ```clojure
   :graphs/list
   (p/let [graphs (index/<index-list db user-id)
           user-rsa-key-pair (index/<user-rsa-key-pair db user-id)
           user-rsa-keys-exists?
           (and (string? (:public-key user-rsa-key-pair))
                (string? (:encrypted-private-key user-rsa-key-pair)))]
     (http/json-response :graphs/list
                         {:graphs graphs
                          :user-rsa-keys-exists? user-rsa-keys-exists?}))
   ```
   Server gibt `user-rsa-keys-exists?` als Antwort-Flag mit zurück.

2. Client-Side in `<ensure-user-rsa-keys-on-server!`
   (`src/main/frontend/handler/db_based/sync.cljs:146-148`):
   ```clojure
   (defn- <ensure-user-rsa-keys-on-server!
     [{:keys [server-rsa-keys-exists?]}]
     (if (not= false server-rsa-keys-exists?)   ; <-- GUARD
       (p/resolved nil)                          ; no-op when keys exist
       ...generate-and-upload...))
   ```
   Wenn der Server-Flag `true` ist, macht der Client gar nichts.

3. Client reicht Flag aus Server-Response durch
   (`sync.cljs:316`):
   ```clojure
   _ (<ensure-user-rsa-keys-on-server! {:server-rsa-keys-exists?
                                        (:user-rsa-keys-exists? resp)})
   ```

**Ergebnis: ✅ verifiziert — und besser als angenommen.** Die Annahme
"Browser B würde überschreiben" war falsch. Der existierende Client-Code
ist bereits cross-device-safe:
- Browser A generiert Keys, uploaded
- Browser B holt `/graphs`, sieht `:user-rsa-keys-exists? true`
- Browser B ruft `<ensure-user-rsa-keys-on-server!` → no-op
- Keine Überschreibung

**Bonus-Erkenntnis (E2EE-Cross-Device-Realität):** Der
`encrypted_private_key` ist nicht zufällig client-local verschlüsselt
sondern mit einem **User-gewählten E2EE-Password** via PBKDF2+AES
(`src/main/frontend/common/crypt.cljs:87-148`). Das heißt:
- E2EE-Cross-Device ist technisch möglich — User muss in Browser B
  dasselbe E2EE-Password eintippen, dann ist der server-gespeicherte
  encrypted_private_key entschlüsselbar (`:rtc/decrypt-user-e2ee-private-key`
  Event in `handler/events/rtc.cljs:26`)
- Die User-Reise ist aber: "Cloud-Sync-Haken UND E2EE-Haken anklicken,
  Password merken, in jedem Device eintippen". Das ist zwei Stufen UX
  komplexer als "nur Cloud-Sync-Haken".

**Implikation für Phase 1.6:**
- Patch #5 (Hypha-skip von `<ensure-user-rsa-keys-on-server!`) ist
  **nicht nötig**. Der existierende Guard reicht.
- Patches-Inventar bleibt bei 4/20.
- E2EE-Default-Off in `new-db-graph-inner` (Patch #4) bleibt richtig
  als Default — die Mehrheit der Hypha-Personal-Cloud-User braucht
  E2EE nicht (sie vertrauen ihrem eigenen Server).
- **U22 wird umformuliert** (s.u.): E2EE-Cross-Device ist NICHT
  Phase-2-blocker, sondern Phase-1.6-optional. Wer das E2EE-Password
  manuell verwaltet, kann es heute schon (nach M8+M9) nutzen.
  Phase-2-Material ist nur das _automatische_ Key-Sync via
  Recovery-Phrase oder passwortlose KDF.

### V10 — End-to-End auf Localhost durchgespielt

**Status:** ✅ Verifiziert via Docker-Container (`docker compose -f docker-compose.hypha.yml up`)
auf localhost:3030 + Playwright headless + curl HTTP-Probe.

**Befund #1 — Auth-Race-Bug entdeckt, gefixt (M9.4):**

Erstes V10-Probe-Run zeigte folgenden Worker-Error nach Login:
```
[frontend.handler.db-based.sync] {:db-sync/ensure-user-rsa-keys-failed
  {:error #error {:message "worker auth refresh requires refresh token",
                  :data {:code :missing-refresh-token}},
   :reason :server-rsa-keys-missing}}
```

Root cause: M9.1's `<fetch-remote-graphs-after-login!` ruft
`<get-remote-graphs`, das sync.cljs:316 `<ensure-user-rsa-keys-on-server!`
über die Frontend→Worker-Grenze invoked. Stock-Logseq's
`:rtc/sync-app-state`-Event (`handler/events/rtc.cljs:88`) gated den
Worker-Auth-State-Push auf `:git/current-repo` — aber M9.1 läuft VOR
jedem Graph-Load. Folge: Worker hat kein `:auth/id-token`, fällt in den
Cognito-Refresh-Pfad in `worker/sync/auth.cljs:51`, wirft fail wegen
fehlendem refresh-token.

**Fix (M9.4):** Hypha-eigen, additiv in `frontend.hypha.init`:
- `<wait-for-db-worker-ready!` mit Watch-Pattern auf `state/*db-worker`
- `<push-auth-to-db-worker!` synct `:auth/id-token` + `:auth/access-token`
  via `:thread-api/sync-app-state` zum Worker, sobald dieser ready ist
- `<fetch-remote-graphs-after-login!` führt diesen Push als ersten Schritt
  durch, dann erst `<get-remote-graphs`

0 zusätzliche Upstream-Patches. Patches-Inventar bleibt 4/20.

**Befund #2 — V10 grün:**

V10-HTTP-Probe (`/tmp/opencode/v10-http.sh`):
1. User-A loggt sich ein → JWT mit `sub=00000000-0000-0000-0000-000000000001`
2. User-A POSTet RSA-Stub-Keys an `/e2ee/user-keys` → 200
3. User-A POSTet `/graphs` → bekommt `graph-id` zurück
4. User-A GET `/graphs` → Liste enthält neuen Graph
5. User-B loggt sich ein (frische Session, gleicher Access-Code) → JWT mit
   identischem `sub` (Cross-Device-Identity verifiziert)
6. User-B GET `/graphs` → sieht User-A's Graph in der Liste
7. User-B GET `/graphs/<id>/access` → 200 (Access-Check grün)

V10-Browser-Probe (Playwright headless chromium):
- M9.1 Auto-Fetch `GET /graphs → 200` nach jedem Login (frischer + Cookie-Restore)
- M9.4 keine `:missing-refresh-token`-Errors in der Browser-Console mehr
- `GET /e2ee/user-keys → 200` fließt korrekt durch den M8-Proxy
- Cross-Device-Cookie-Isolation: zweite BrowserContext zeigt erneut
  Login-Modal trotz erfolgreicher Auth in der ersten

**Implikation für M10:**

M10's cross-device.spec.ts wird um einen vierten Test erweitert (T5):
"M9.4 — no 'worker auth refresh requires refresh token' after login".
Drift-Gate gegen zukünftige Removal des `<push-auth-to-db-worker!`-Aufrufs.

**Befund #2 — Reverse-Proxy-Origin-Leak (M9.5, fixed):**

Mit dem M9.4-Fix verifizierte ich V10 weiter und entdeckte: Klick auf
einen Remote-Graph in Browser B triggerte `<rtc-download-graph!`, der
führte zu:

```
TypeError: Failed to fetch
  at <db-worker>/.../sync/download.cljs ...
  url: http://127.0.0.1:8787/sync/<graph-id>/snapshot/stream
```

Der Browser bekam eine URL `http://127.0.0.1:8787/...` zurück — der
Container-interne Loopback-Port des db-sync-Node-Adapters, vom Browser
nicht erreichbar.

Root cause: `deps/db-sync/.../worker/handler/sync.cljs:133`
(`snapshot-stream-url`) baut die URL aus `request.url.origin` —
hinter Hypha's Reverse-Proxy war das `http://127.0.0.1:8787`,
nicht der Browser-Public-Origin.

**Fix M9.5 (2-stufig, 1 Hypha-Patch):**

(a) `hypha-server/src/proxy.ts` setzt explizit `X-Forwarded-Host` +
    `X-Forwarded-Proto` für alle proxied Routen (`/sync`, `/graphs`,
    `/e2ee`, `/assets`). Liest den Host vom FastifyRequest (nicht von
    den downstream-Headers, die fastify-reply-from VOR dem
    rewriteRequestHeaders-Hook bereits zum Upstream-Host rewritted).

(b) `deps/db-sync/.../worker/handler/sync.cljs` (`snapshot-stream-url`)
    respektiert `X-Forwarded-Host`/`X-Forwarded-Proto` wenn gesetzt;
    fall-back auf `request.url.origin` für direkte (non-proxied)
    Deployments. Dies ist Patches #5 in HYPHA_PATCHES.md.

Verifikation (curl + Playwright):
- `GET /sync/<id>/snapshot/download` returnt nun JSON mit
  `"url":"http://localhost:3030/sync/<id>/snapshot/stream"`
- Browser-Folge-Fetch `GET /sync/<id>/snapshot/stream → 200` (vorher
  `TypeError: Failed to fetch`)
- Click auf Remote-Graph triggert Download-Flow (Body zeigt "Wird
  heruntergeladen...")

**Bekannter Pre-existing Logseq-Bug (V10 sichtbar gemacht):**

Nach M9.5 läuft der Download-Stream durch, der Browser empfängt die
Snapshot-Daten, aber der **Snapshot-Import in die lokale OPFS-DB
hängt** mit:

```
[frontend.worker.sync.download] :rehydrate-large-title-failed
  Error: Attribute :logseq.property.sync/large-title-object should be
  marked as :db/index true
```

Root cause: `:logseq.property.sync/large-title-object` ist eine
built-in property (`deps/db/.../property.cljs:701`) UND wird via
`(d/datoms db :avet large-title-object-attr)` in
`worker/sync/large_title.cljs:51,259` indiziert nachgeschlagen. Aber
das statische Datascript-Schema (`deps/db/.../schema.cljs:56-108`)
markiert es NICHT als `:db/index true`.

Das ist ein **Logseq-Upstream-Schema-Inkonsistenz**. Frühere Versuche,
sie zu beheben durch Schema-Patch in `schema.cljs` lösten einen
sekundären Konsistenz-Check im db-sync-Adapter aus ("malli DB schema
is missing... non-ref attributes"), weil die Malli-Entity-Schemata
keine entsprechende Definition hatten.

**Status:** behoben in M11 (siehe §4).

## 4. Meilensteine

### M8 — Server-side `/graphs`, `/e2ee`, `/assets` Proxy

**Datei:** `hypha-server/src/proxy.ts` (additive Erweiterung um zwei Block-Aufrufe)

```typescript
// Zusätzlich zum bisherigen /sync und /asset:
await app.register(fastifyHttpProxy, {
  upstream: deps.upstreamUrl, prefix: "/graphs", rewritePrefix: "/graphs",
});
await app.register(fastifyHttpProxy, {
  upstream: deps.upstreamUrl, prefix: "/e2ee", rewritePrefix: "/e2ee",
});
await app.register(fastifyHttpProxy, {
  upstream: deps.upstreamUrl, prefix: "/assets", rewritePrefix: "/assets",
});
```

Plus: `/asset` (singular) kann entfernt werden, falls V8 bestätigt dass
nichts mehr es benutzt — alternativ behalten als Toter-Pfad-Reserve.

#### M8 — Use Cases erfüllt

- **U1** (teilweise, Server-Anteil): `POST /graphs` ist erreichbar, neuer Graph wird auf dem Server registriert
- **U2** (teilweise, Asset-Anteil): `PUT/GET /assets/<graph-id>/<uuid>` funktioniert. Block-Tx-Sync läuft bereits über `/sync/*` (unverändert)
- **U4** (Server-Anteil): `GET /graphs`, `GET /graphs/<id>/access` antworten valide JSON statt 404
- **U6**: Asset-Uploads vom Browser landen tatsächlich im `/data/<graph-uuid>/assets/`-Verzeichnis

#### M8 — Use Cases bewusst nicht erfüllt

- **U3** (gehört zu M9): Browser B sieht die Liste der Remote-Graphen nach Login automatisch — braucht Client-Side-Auto-Fetch in `hypha-init`
- **U5** (gehört zu M9): Toolbar-Cloud-Icon für nachträglichen Upload ist nicht sichtbar — gated auf `logged-in?`-Fix
- **U23** (gehört zu Phase 2): Auto-Migration bestehender lokaler Graphen
- **U20-U22** (Phase 2): Multi-User, Realtime, E2EE-Key-Sync

#### M8 — DoD

- `pnpm --dir hypha-server test` grün (3 neue Unit-Tests: `proxy.test.ts` deckt `/graphs`, `/e2ee`, `/assets` Routen + Status-Pass-through ab)
- `pnpm --dir hypha-server build` strict-clean
- Manueller curl-Test gegen laufenden Container: `curl -H "Authorization: Bearer <jwt>" http://localhost:3030/graphs` liefert JSON-Liste (leer beim ersten Mal)
- `/health` unverändert (V7)
- Patches-Bilanz: weiterhin 2/20

### M9 — Hypha-Client: Auto-Fetch + `logged-in?` + UX-Defaults

**Drei Änderungen:**

#### M9.1 Hypha-eigen: Auto-Fetch nach Login

**Datei:** `src/main/frontend/hypha/init.cljs` (~10 LoC additive)

Nach erfolgreichem `set-hypha-id-token!` einen Async-Trigger setzen, der
`<get-remote-graphs` aufruft (umgeht das gebrochene
`:user/fetch-info-and-graphs`-Event, das `<user-info` gegen
`api.logseq.com` werfen würde):

```clojure
(defn- <fetch-remote-graphs-after-login! []
  ;; direct call into RTC handler, no upstream event-bus detour
  (-> (rtc-handler/<get-remote-graphs)
      (p/catch (fn [e] (log/error :hypha/initial-graph-fetch-failed e)))))
```

Aufruf direkt nach `set-hypha-id-token!` in beiden Pfaden:
- `start!` nach 200er-Session-Restore (Zeile 60-62)
- `hypha-login/modal-inner` nach erfolgreichem Code-Login

#### M9.2 Upstream-Patch #3: `logged-in?` Hypha-aware

**Datei:** `src/main/frontend/handler/user.cljs:90-93` (Upstream-Patch)

```clojure
(defn logged-in? []
  (if hypha-config/hypha-mode?
    (when-let [token (state/get-auth-id-token)]
      (and (string? token)
           (not (-> token parse-jwt expired?))))
    (let [token (state/get-auth-refresh-token)]
      (when (string? token) (not (string/blank? token))))))
```

Patch wird via `.github/scripts/hypha-patch-anchors.sh` aufgenommen
(Patch #3, ~6 LoC inkl. require von `frontend.hypha.config`).

#### M9.3 Upstream-Patch #4: Hypha-Defaults in `new-db-graph-inner`

**Datei:** `src/main/frontend/components/repo.cljs:608-609`

```clojure
[cloud? set-cloud?]
  (hooks/use-state (boolean hypha-config/hypha-mode?))      ; Default Cloud-On
[graph-e2ee? set-graph-e2ee?]
  (hooks/use-state (not hypha-config/hypha-mode?))          ; Default E2EE-Off
```

Patch #4, ~4 LoC inkl. require von `frontend.hypha.config`.

#### M9 — Use Cases erfüllt

- **U1** (komplett mit M8): Neuer Graph hat Cloud-Default-On, Erstellungs-Flow ruft `<rtc-create-graph-and-start-sync!`, Graph landet auf dem Server
- **U3**: Browser B holt nach Login automatisch die Remote-Graph-Liste, sichtbar im Multi-Graph-Picker (`components/repo.cljs:427`)
- **U4** (komplett mit M8): Klick auf Remote-Graph triggert Download via `[:rtc/download-remote-graph ...]`
- **U5**: Toolbar-Cloud-Icon und "Use sync (beta)"-Menüpunkt sind nun in Hypha sichtbar (`logged-in?` ist `true`)

#### M9 — Use Cases bewusst nicht erfüllt

- **U7** (gehört zu M10): Automatisierte Verifikation — manueller Probe-Run (V10) reicht für M9-DoD
- **U22** (Phase 2): E2EE-Default ist off, aber wer es manuell anschaltet, hat _kein_ funktionierendes Cross-Device. M9 macht E2EE-aus zur Hypha-Default-Voraussetzung; E2EE-Sync ist Phase-2-Material
- **U23** (Phase 2): Bestehende lokale Graphen werden _nicht_ automatisch hochgeladen. M9 macht die UI sichtbar (über U5), der User klickt selbst. Auto-Migration mit Konflikt-Resolution = Phase 2

#### M9 — DoD

- V10 manuell durchgespielt: Firefox erstellt Graph (Cloud-On default), Chrome listet ihn nach Login, Download funktioniert
- `bb dev:lint-and-test` grün
- `clojure -M:cljs compile app --config-merge '{...HYPHA-MODE true}}'` grün, 0 Warnings
- `bb lint:worker-and-frontend-separate` grün
- Patches-Bilanz: 4/20

### M10 — Cross-Device Drift-Gate (Playwright)

**Datei:** `hypha-server/test/playwright/cross-device.spec.ts` (NEU, ~140 LoC Test)

**Scope-Anpassung gegenüber dem ursprünglichen Plan-Entwurf:**

Der Original-§4-M10-Plan beschrieb einen **vollen Cross-Browser-Roundtrip**:
Browser A erstellt Cloud-Graph + editiert Block, Browser B fetched Liste +
downloaded Snapshot + sieht editierten Block. Das setzt aber einen
**stateful echten db-sync-Adapter** im Test voraus:

- `POST /graphs` muss neue Graph-UUID erstellen und persistieren
- `GET /graphs` muss die soeben erstellte Graph in der Liste haben
- WebSocket `/sync/<uuid>` muss Tx-Stream akzeptieren und echo'n
- Snapshot-Download muss editierten Block-Inhalt zurückliefern

Heute im Test-Setup steht aber der `fake-adapter.js`: ein No-Op-Stub, der
nur die Ready-Line ausgibt und nicht antwortet. Der echte
`deps/db-sync/worker/dist/node-adapter.js` ist verfügbar, benötigt aber
das `better-sqlite3`-Native-Modul (das auf vielen Entwicklungs-Systemen
inkl. der lokalen Maschine fehlt — sichtbar als pre-existing
`integration.test.ts`-Fail).

Eine **mockSync-Erweiterung um Stateful-Graph-Storage** (in-memory
Map<graph-id, graph-data>) wäre eine Eigen-Implementation von
~200-300 LoC und replikat von Logik, die in
`deps/db-sync/src/.../worker/handler/`-Familie schon lebt. Das ist
out-of-proportion für einen Smoke-Test.

**M10-Scope reduziert auf Drift-Gates für die M9-Mechaniken:** das
sind die Code-Pfade, die durch zukünftige Upstream-Sync-Merges silent
brechen könnten. Funktionale Cross-Device-Verifikation ist V10
(manueller Lokal-Smoke nach M9) und Phase-2-M11 (echter Adapter im
CI-Image inkl. better-sqlite3-binary).

**Tests (5 Stück):**

1. **T1 — M9.1 Auto-Fetch Drift-Gate:** Nach Login (fresh access-code)
   feuert `GET /graphs` automatisch. Network-Tap auf `page.on("request", ...)`.
   Bricht, wenn jemand `<fetch-remote-graphs-after-login!` aus
   `set-hypha-id-token!` entfernt.

2. **T2 — M9.1 Robustness across Reload:** Cookie-Session-Restore-Pfad
   (Reload mit gültigem Cookie) feuert ebenfalls `GET /graphs`. Bricht,
   wenn Hypha-Init's `start!` den Auto-Fetch nur bei einer der beiden
   Codepfade triggert.

3. **T3 — Cross-Device User-Identity:** Zwei `BrowserContext` mit
   demselben Access-Code bekommen JWTs mit identischem `sub`-Claim
   (UUID-formatiert, gleicher Wert). Bricht, wenn `hypha-server/src/auth/jwt.ts`
   den `sub` jemals zufällig per Session generieren würde (was Cross-Device
   sofort unmöglich machte).

4. **T4 — Cookie-Jar-Isolation:** Two contexts haben separate
   Session-Cookies. Context A's `/auth/login` macht Context B nicht
   authentifiziert. Bestätigt die Cross-Device-Semantik (jedes Gerät
   muss eigene Auth-Geste machen), und schützt vor Cookie-Domain-Mistakes.

5. **T5 — M9.4 Worker-Auth-State-Pre-Push Drift-Gate** (added post-V10):
   Nach Login darf KEINE Console-Error mit `:missing-refresh-token` oder
   `worker auth refresh requires refresh token` auftauchen. Bricht, wenn
   jemand das `<push-auth-to-db-worker!` aus
   `<fetch-remote-graphs-after-login!` in `hypha/init.cljs` entfernt
   oder hinter dem `<get-remote-graphs`-Call platziert.

#### M10 — Use Cases erfüllt

- **U7** (eingeschränkt): Deterministischer CI-Test verifiziert die
  drei M9-Mechaniken (Auto-Fetch + Identity + Isolation). Bricht
  zuverlässig, wenn:
  - Hypha-Init das Auto-Fetch silent verliert (T1+T2)
  - Server-side JWT-Generation zufällig wird (T3)
  - Cookie-Setup leaks zwischen Contexts (T4)

#### M10 — Use Cases bewusst nicht erfüllt (alle deferred to Phase 2 M11)

- **U7-full**: Browser A erstellt Cloud-Graph → Browser B sieht echten
  Inhalt nach Download. Braucht stateful db-sync-Adapter im CI.
- **U21**: Live-Sync (A+B parallel editieren, sehen sich live).
- **U6-end-to-end**: Asset-Upload-Roundtrip Browser A → Browser B
  (M8-Unit-Tests prüfen Proxy-Pfad; voller Roundtrip braucht
  Stateful-Asset-Storage).

#### M10 — DoD

- `pnpm --dir hypha-server exec playwright test` 16/16 grün (6 Auth +
  6 Marketplace + 4 Cross-Device)
- Test läuft in unter 60s wall-clock zusammen mit den anderen 12 Specs
  (`upstream-sync.yml` hat 120s-Budget aus Phase 1.5)
- CI-Pipelines `hypha-build.yml` und `upstream-sync.yml` picken den
  neuen Spec automatisch via `testMatch` auf (keine YAML-Änderungen)
- Patches-Bilanz: 4/20 (unverändert seit M9)

### M11 — Schema-Konsistenz für `:logseq.property.sync/large-title-object`

**Dateien:** `deps/db/src/logseq/db/frontend/schema.cljs` + `malli_schema.cljs`

Der Snapshot-Download-Pfad (post-M9.5) hängt im Worker-Import bei
`rehydrate-large-titles-from-db!` mit:
```
Attribute :logseq.property.sync/large-title-object should be marked
as :db/index true
```

Root cause aus V10-Diagnose (siehe §3 Befund #2):
- `worker/sync/large_title.cljs:51,259` ruft `(d/datoms db :avet attr)` auf
- Datascript braucht dafür `:db/index true` im Schema
- Das statische Datascript-Schema (`deps/db/.../schema.cljs:56-108`) hat
  den Eintrag nicht
- Direkter Schema-Patch alleine löst secondary check im db-sync-Adapter
  aus ("malli DB schema is missing... non ref attributes"), weil die
  Malli-Entity-Schemata das Attribute auch nicht in einer attr-list haben

**Fix (zwei-stufig, 1 Patch-Inventar-Eintrag — beide Files in deps/db
sind Logseq-Upstream-Code, zusammen ein einziger semantischer Patch #6
im Inventar):**

(a) `deps/db/.../schema.cljs` Map-Extension um:
   ```clojure
   :logseq.property.sync/large-title-object {:db/index true}
   ```

(b) `deps/db/.../malli_schema.cljs` `page-or-block-attrs` Extension um:
   ```clojure
   [:logseq.property.sync/large-title-object {:optional true} :map]
   ```
   Im `page-or-block-attrs`, weil das Attribute auf Block-Entities lebt
   die gleichzeitig in pages und blocks rendered werden. `:optional`
   weil nur Blocks mit large titles es haben.

#### M11 — Verifikations-Probes (vor Implementation)

V11 (`:logseq.property.sync/large-title-object` symmetrie post-fix):
  - clj-kondo lint clean auf beiden Files
  - `pnpm --dir deps/db-sync run build:node-adapter` 0 warnings
  - Container startup: node-adapter wirft KEINEN
    "malli DB schema is missing"-Error
  - Datascript schema-version-Compatibility-Check (`compare-schema-version`)
    bleibt happy

V12 (end-to-end Cross-Device-Datenflow):
  - Browser A erstellt Cloud-Graph + editiert Block mit unique marker
  - Browser B (fresh context) loggt sich ein, sieht Graph, klickt
  - Download completes (UI verlässt "Wird heruntergeladen...")
  - Block-Marker aus Browser A ist in Browser B sichtbar
  - **DAS ist die finale V10-DoD aus dem User-Story-Ursprung**

#### M11 — Use Cases erfüllt

- **U4-vollständig** (Phase-1.6-Closer): Browser B klickt Remote-Graph
  → Download läuft komplett durch → Graph öffnet sich → editierter
  Inhalt aus Browser A sichtbar
- **U7-vollständig** (Phase-1.6-Closer): die ursprünglich gemeinte
  V10-User-Story ("Firefox erstellt, Chrome sieht") funktioniert
  end-to-end byte-für-byte, nicht nur HTTP-Pfad

#### M11 — Use Cases bewusst nicht erfüllt

- **U21** (Phase 2): Live-Sync zwischen aktiven A+B parallel
- **U22** (Phase 2): Automatischer E2EE-Key-Sync (manual-password weiter
  funktional via M9.3-Defaults-Toggle)

#### M11 — DoD

- V11 + V12 grün
- `bb dev:lint-and-test` weiterhin grün (frontend tests betroffen?
  vermutlich nicht, aber prüfen)
- `pnpm --dir hypha-server test:headless-auth` 17/17 grün (keine Regression)
- Manueller V10-Test im Browser: Block-Marker in Chrome sichtbar nach Click
- Patches-Bilanz: 5/20 → 6/20

## 5. Patches-Bilanz

| # | Datei | Zweck | Phase | LoC |
|---|---|---|---|---|
| 1 | `frontend/handler.cljs` | Hypha-Init-Hook nach `restore-tokens-from-localstorage` | Phase 1 | ~3 |
| 2 | `frontend/handler/events/ui.cljs` | `:user/login`-Routing → Hypha-Modal | Phase 1 | ~3 |
| 3 | `frontend/handler/user.cljs` | `logged-in?` Hypha-aware | Phase 1.6 M9 | ~6 |
| 4 | `frontend/components/repo.cljs` | Hypha-Defaults in `new-db-graph-inner` | Phase 1.6 M9 | ~4 |
| 5 | `deps/db-sync/.../worker/handler/sync.cljs` | `snapshot-stream-url` respektiert X-Forwarded-Host | Phase 1.6 M9.5 | ~13 |
| 6 | `deps/db/.../schema.cljs` + `malli_schema.cljs` | `:db/index true` für `large-title-object` plus malli-Symmetrie | Phase 1.6 M11 | ~5 |

End-Inventar nach Phase 1.6: **6/20** (30% Smell-Schwelle).

Alle anderen Phase-1.6-Code-Änderungen sind additiv:
- `hypha-server/src/proxy.ts`: 3 neue `register`-Aufrufe (Hypha-eigen, kein Logseq-Patch)
- `src/main/frontend/hypha/init.cljs`: +10 LoC Auto-Fetch (Hypha-eigen)
- `hypha-server/test/playwright/cross-device.spec.ts`: NEU (Hypha-eigen)
- M8 Unit-Tests in `hypha-server/test/`: NEU (Hypha-eigen)

## 6. Risiken und offene Fragen

### R1 — `<ensure-user-rsa-keys-on-server!`-Konflikt zwischen Devices

**Aufgelöst durch V9.** Existierender Client-Guard (`sync.cljs:148`)
plus Server-Flag in `:graphs/list`-Response macht das System bereits
cross-device-safe. Kein Patch #5 nötig.

### R2 — User-Identitäts-Konsistenz im Single-User-Hypha-Modell

Beide Browser bekommen JWTs mit demselben `sub` (Hypha-User-UUID),
weil `hypha-server/src/auth/jwt.ts:23-43` aus der Session-User-Identität
mintet. Der Access-Code projiziert auf eine feste User-Identität.
**Sollte funktionieren**, aber V10 manuell verifizieren.

### R3 — Asset-Upload-Path-Mismatch Phase 1 vorhanden?

V8 prüft. Falls Phase 1 (oder Phase 1.5) jemals Assets erfolgreich
hochgeladen hat, ist die Annahme `/asset/` ist tot evtl. falsch. Im
Zweifel beide Pfade routen, Plan-Entscheidung später anpassen.

### R4 — Multi-Browser-Tabs als derselbe User vs. zwei Browser

Stock-Logseq.com behandelt mehrere Sessions desselben Users über
RTC-Presence-IDs. Hypha-Phase-1.6 hat _nicht_ Realtime-Sync getestet —
nur "B kommt nachträglich rein, sieht den Stand". Falls A und B
gleichzeitig editieren während B noch downloaded, gibt es eventuell
Tx-Konflikte. Dokumentieren als "Phase 1.6 macht Multi-Device
sequenziell-konsistent, nicht parallel-konsistent". Multi-Tab desselben
Users in einem Browser ist heute schon kein Use-Case, der definiert
ist — sequenzielle Konsistenz reicht.

### R5 — Was passiert wenn der hypha-user in Browser B Schritt 1 anders erlebt?

Ablauf-Edge-Case: User öffnet Chrome zum ERSTEN MAL bevor er
irgendwas in Firefox erstellt hat. Erwartung: leere Graph-Liste,
Onboarding-Demo-Graph wird angelegt. Dann später Firefox erstellt einen
Cloud-Graph. Nach F5 in Chrome: erscheint die Cloud-Graph in der
Liste neben dem Demo-Graph? Sollte ja, weil Auto-Fetch nach Page-Load
+ Auth läuft. V10 kann diesen Pfad mit abdecken.

## 7. Self-Hosting-Docs-Update (M10 oder separater Polish-Commit)

`docs/hypha/self-hosting.md:178-187` enthält stale "Things that don't
work yet"-Behauptungen:
- "Multi-user" — bleibt stale, korrekt Phase 2
- "Realtime collaboration" — bleibt stale, korrekt Phase 2
- "Mobile apps" — bleibt stale, korrekt Phase 2+
- "Plugin marketplace … aren't tested" — ist nach Phase 1.5 stale, korrigieren

Phase 1.6 bringt zusätzlich: **"Cross-Device works"** als positive Aussage in
self-hosting.md. Plus expliziter Hinweis: "E2EE is off by default for
self-hosted; key-sync between devices is Phase 2."

## 8. Phase-1.6-Sign-off Checklist

| # | Kriterium | Wo verifiziert |
|---|---|---|
| 1 | V7-V10 grün und in docs/hypha/phase-1.6-cross-device.md committed | nachgereichter `docs(hypha)`-Commit |
| 2 | M8 Server-Routes erreichbar | `hypha-server` Unit-Tests + curl-Probe |
| 3 | M9 Patches landen, Hypha-Build clean | clj-kondo + `clojure -M:cljs compile` |
| 4 | M10 Playwright-Spec grün lokal und in CI | `pnpm --dir hypha-server test:headless-auth` |
| 5 | Patches-Inventar dokumentiert | `.github/scripts/hypha-patch-anchors.sh` + dieser Plan §5 |
| 6 | User-Story aus §0 manuell verifiziert | Manuell auf localhost:3030 Firefox+Chrome |
| 7 | `docs/hypha/self-hosting.md` aktualisiert | §7 |
