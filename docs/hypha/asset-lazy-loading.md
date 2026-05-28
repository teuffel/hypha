# Asset Lazy-Loading — Architektur-Verifikation

**Status:** dokumentiert 2026-05-28 nach Phase 1.6 Sign-off.
**Zweck:** Belegen, welche Asset-Loading-Eigenschaften Hypha aktuell hat,
damit Phase-2-Diskussionen (Range, Eviction) gegen einen geprüften
Ist-Zustand arbeiten können statt gegen Vermutungen.

**Vorgänger:** Phase 1.6 (Cross-Device Personal Cloud) — abgeschlossen.
**Verwandte Doks:** `docs/hypha/phase-1.6-cross-device.md` (V7–V12 für die
Cross-Device-Mechanik), `HYPHA_PATCHES.md` (Patch #5 `/assets/`-Proxy).

## 0. Warum diese Doku

Aus dem Cross-Device-Befund wissen wir, dass `hypha-server`s
`@fastify/http-proxy` `/asset/*` separat von `/sync/*` an den
Node-Adapter durchreicht. Diese Trennung legt nahe, dass
Asset-Binaries unabhängig vom Tx-Stream geholt werden — also
potenziell lazy. Diese Doku belegt oder widerlegt das empirisch am
Code, plus Probes mit dem laufenden Container.

Untersucht wurden vier Fragen (analog zu V1–V4 in den Phase-Plänen):
- **VA1**: Echtes Lazy oder verzögertes Eager?
- **VA2**: Cache-Verhalten + Eviction
- **VA3**: HTTP-Range-Support
- **VA4**: Upload-Richtung + Proxy-Methoden-Abdeckung

## 1. VA1 — Echtes Lazy oder verzögertes Eager?

**Verdict: BESTÄTIGT — echtes On-Demand-Lazy beim Block-Render.**

Pfad "Block referenziert Asset" → "Binary im Speicher":

| # | Datei:Zeile | Schritt |
|---|---|---|
| 1 | `src/main/frontend/components/block.cljs:1099-1101` | `asset-cp` Rum-Komponente: `:did-mount` + `:did-update` rufen `maybe-request-asset-download!` |
| 2 | `src/main/frontend/components/block.cljs:1069-1082` | Lokales `maybe-request-asset-download!` prüft `file-ready?`, ruft `assets-handler/maybe-request-remote-asset-download!` |
| 3 | `src/main/frontend/handler/assets.cljs:285-294` | Frontend-Handler invoked `:thread-api/db-sync-request-asset-download repo asset-uuid` |
| 4 | `src/main/frontend/handler/assets.cljs:270-283` | Gate `should-request-remote-asset-download?` — nur wenn `file-ready?=false`, `external-url` leer, kein in-progress |
| 5 | `src/main/frontend/worker/db_core.cljs:661-663` | Thread-API → `db-sync/request-asset-download!` |
| 6 | `src/main/frontend/worker/sync/assets.cljs:355-381` | `request-asset-download!` checkt `platform/asset-stat` (`missing-local?`), nur dann `download-remote-asset!` |
| 7 | `src/main/frontend/worker/sync/assets.cljs:302-346` | `download-remote-asset!` macht `GET <base>/assets/<graph>/<uuid>.<type>`, schreibt in OPFS via `<write-asset-bytes!` |

**Trigger sitzt pro Asset-Block in der React-Lifecycle.** Kein
Prefetch-Loop, kein "alle Assets vorab"-Bulk. Auch im
Snapshot-Download-Pfad (`worker/sync/download.cljs/complete-datoms-import!`)
wird nichts asset-spezifisches eager geladen — der Snapshot enthält nur
die Datascript-Daten, Asset-Binaries bleiben Server-seitig liegen, bis
ein Block sie anfordert.

## 2. VA2 — Cache-Verhalten + Eviction

**Verdict (Phase 1.6 Stand): BESTÄTIGT (IDB-Cache via LightningFS) +
KORRIGIERT (kein Eviction).**

**Phase 1.6.1 Update:** LRU-Eviction nachgerüstet — siehe
[`phase-1.6.1-asset-cache.md`](./phase-1.6.1-asset-cache.md) und §6 U31
unten.

**Terminologie-Update:** Die ursprüngliche Phase-1.6-Notiz sprach von
"OPFS-Cache". Das ist nicht ganz akkurat: SQLite-Datenbanken liegen
in OPFS (via `@sqlite.org/sqlite-wasm` SAH-Pool), aber
**Asset-Binaries** liegen in einer IndexedDB-Database namens `logseq`
(via LightningFS mounted at `memory:///`). Siehe
`resources/js/worker.js:18-19` für den `LightningFS('logseq')`-Setup
und `src/main/frontend/persist_db/browser.cljs:104,107` für die
`window.pfs`-Comlink-Bridge.

| Aspekt | Beleg |
|---|---|
| Cache-Location | LightningFS auf IndexedDB (`logseq` DB), Pfade unter `memory:///<graph-name>/assets/<asset-uuid>.<asset-type>` via `src/main/frontend/worker/platform/browser.cljs:141-147 asset-write-bytes!` |
| Cache-Key | `<asset-uuid>.<asset-type>` aus `src/main/frontend/worker/sync/assets.cljs:29-31 asset-file-name` |
| Cache-Lookup vor Fetch | `assets.cljs:367-372` ruft `platform/asset-stat`; truthy → `missing-local?=false` → kein Download |
| Upstream-Eviction-Mechanismus | **NICHT vorhanden.** `asset-delete!` (`browser.cljs:158-162`) wird ausschließlich durch `:remove-asset`-Op aus dem Server-Tx-Stream getriggert (`assets.cljs:239-251`) — also nur dann, wenn der Server explizit "Asset gelöscht" sagt |
| Hypha-Eviction (Phase 1.6.1) | `frontend.hypha.asset-cache` — Background-Interval, LRU by LightningFS `mtimeMs`, trigger bei `usage/quota > 0.8`, target 0.6. Hypha-eigen, kein Upstream-Patch |

**Pre-1.6.1 Konsequenz war:** Cache wuchs monoton. Bei jahrelangem
Personal-Cloud-Use mit vielen Anhängen müsste der User manuell IDB
leeren oder den gesamten lokalen Graphen löschen+re-downloaden.

**Post-1.6.1:** Background-Eviction hält den Browser-Storage-Pool
(IDB + OPFS + Cache-API + SW gemeinsam laut
`navigator.storage.estimate()`) unter 80% durch Löschen von
LRU-Asset-Files. Evictete Assets werden bei Re-Render durch
VA1-Lazy-Path neu vom Server geholt — akzeptable Trade-Off zwischen
Quota-Druck und gelegentlichem Re-Download.

## 3. VA3 — HTTP-Range-Request-Support

**Verdict: KORRIGIERT — kein Range-Support auf Adapter-Ebene; Proxy
ist durchsichtig, aber Upstream macht nichts mit dem Header.**

### 3.1 Empirisch (curl gegen Container, 2026-05-28)

```
$ JWT=$(curl -sS -X POST http://localhost:3030/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"code":"..."}' | jq -r '."id-token"')
$ curl -sS -X PUT "http://localhost:3030/assets/<graph>/<uuid>.txt" \
    -H "Authorization: Bearer $JWT" \
    -H "x-amz-meta-checksum: deadbeef" -H "x-amz-meta-type: txt" \
    --data-binary "test-binary-content"
{"ok":true}

$ curl -sS -X GET "http://localhost:3030/assets/<graph>/<uuid>.txt" \
    -H "Authorization: Bearer $JWT" \
    -H "Range: bytes=0-4" \
    -D -
HTTP/1.1 200 OK      ← NICHT 206
content-length: 20   ← FULL body, nicht 5 bytes
content-type: application/x-www-form-urlencoded
x-asset-size: 20
...
test-binary-content
```

### 3.2 Code-Belege

| Ebene | Beleg | Verdict |
|---|---|---|
| Node-Adapter | `deps/db-sync/src/logseq/db_sync/worker/handler/assets.cljs:52-91 handle-get-asset` lädt komplettes Bucket-Object via `(.get bucket key)` und antwortet mit `status 200` (Z. 88). Kein Range-Header-Parsing, kein `content-range`-Header, kein partial-read | ❌ Kein Range |
| hypha-server proxy.ts | `hypha-server/src/proxy.ts:118-123` registriert `/assets`-Proxy ohne Method-Restriction. `@fastify/http-proxy` reicht beliebige Header (inkl. Range) durch | ✅ Durchsichtig — Header wandert weiter, aber Upstream antwortet eh 200 |

**Konsequenz:** Eine 80-MB-PDF wird komplett geladen, bevor Seite 1
sichtbar wird. Lazy-Load greift auf Asset-Granularität, nicht
Byte-Bereich-Granularität.

## 4. VA4 — Upload-Richtung

### 4.1 Upload-Trigger-Zeitpunkt

**Verdict: BESTÄTIGT — sofortiger Upload nach lokaler Tx, asynchron.**

Beleg-Kette:

| # | Datei:Zeile | Schritt |
|---|---|---|
| 1 | `src/main/frontend/worker/sync/apply_txs.cljs:1033-1049` | `handle-local-tx!` läuft bei jeder Frontend-Tx (außer rtc-tx und sync-download-tx) |
| 2 | `apply_txs.cljs:1040` | Aufruf `asset-db-listener/generate-asset-ops repo tx-report` |
| 3 | `src/main/frontend/worker/sync/asset_db_listener.cljs:11-25` | Filtert Datoms mit `:logseq.property.asset/checksum`, generiert `[:update-asset t {:block-uuid ...}]`-Ops, append'd via `client-op/add-asset-ops` |
| 4 | `apply_txs.cljs:1044-1049` | Wenn `db-sync-client` aktiv UND `:logseq.kv/graph-remote?=true` → `enqueue-asset-sync!` async |
| 5 | `worker/sync/assets.cljs:253-283` | `process-asset-ops!` mit `parallelism 10` pop'd die Queue |
| 6 | `assets.cljs:211` | `process-asset-op!` für `:update-asset` → `upload-remote-asset!` |
| 7 | `assets.cljs:129-132` | `PUT /assets/<graph>/<uuid>.<type>` mit Body + Bearer-Auth + `x-amz-meta-checksum` |

**Asset-Upload startet sofort nach Block-Insert/Update.** Asynchron,
blockiert nicht den Editor. Kein "warten bis nächster Sync-Zyklus".

**Subtilität:** Generierung in `asset-db-listener.cljs:22` triggert NUR
auf `:logseq.property.asset/checksum`-Datoms. Das stellt sicher, dass
Logseq's Asset-Pipeline erst dann sync't, wenn das Asset-Binary
fertig in OPFS geschrieben + sein Checksum berechnet wurde. Kein
Halb-Upload von in-progress-Daten.

### 4.2 Proxy-Methoden-Abdeckung

**Verdict: BESTÄTIGT — alle HTTP-Methoden durchgereicht.**

`hypha-server/src/proxy.ts:118-123`:
```typescript
await app.register(fastifyHttpProxy, {
  upstream: deps.upstreamUrl,
  prefix: "/assets",
  rewritePrefix: "/assets",
  replyOptions: sharedReplyOptions,
});
```

Keine `methods`-Option, keine Whitelist. `@fastify/http-proxy` reicht
alle HTTP-Verben durch.

Empirisch verifiziert (2026-05-28):

| Methode | Status | Bemerkung |
|---|---|---|
| `PUT /assets/<graph>/<uuid>.txt` mit Body | 200 | Body landet im Bucket |
| `GET /assets/<graph>/<uuid>.txt` | 200 | Body kommt zurück |
| `DELETE /assets/<graph>/<uuid>.txt` | 200 | Auch auf nonexistent — node-adapter swallowt |
| `OPTIONS` (CORS-preflight) | erlaubt | Adapter setzt `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS,HEAD` |

→ Asset-Upload-Pfad funktioniert symmetrisch zu Download. Kein
Cross-Browser-Lücke-4-Äquivalent für Assets (dank M8's
`/assets/`-Proxy-Registration).

## 5. Synthese

### 5.1 Thin-Client-Aggressivität

**VA1 = echtes Lazy** → Cross-Device leichtgewichtig:

- Browser B's erster Login + Graph-Switch lädt: `/graphs`-Liste,
  Snapshot-Stream (Datascript-DB), **null Asset-Binaries**.
- Asset-Binaries werden erst pro Block bei Render gefetched
  (`asset-cp` `:did-mount`).
- Bei einem Graphen mit 10000 Bildern bleibt der erste Page-Load
  schnell — nur die viewport-sichtbaren Assets werden initial geholt.
- Phase 1.6 ist asset-load-budget-friendly out-of-the-box.

**Caveat aus VA2:** Cache wächst unbegrenzt. Bei jahrelangem
Personal-Cloud-Use mit vielen Anhängen müsste der User manuell OPFS
leeren oder Graph re-downloaden.

### 5.2 Architektur-Eigenschaften, die Asset-Sync hat

1. **Tx-getrieben**: Asset-Ops sind eine semantische Side-Channel-Op,
   nicht im normalen WebSocket-Tx-Stream. Eigene Queue (sqlite-table
   `client_ops` kind=`asset`), eigener Worker-Loop mit Parallelism 10.
   Saubere Separation.

2. **Encryption-aware**: `download-remote-asset!` (assets.cljs:306)
   und `upload-remote-asset!` (Z. 119) umschließen Encryption, wenn der
   Graph e2ee ist. Single-User-Hypha hat e2ee-default-off (M9.3),
   also Bytes-pass-through.

3. **Checksum-Gating**: Asset-Op wird erst generiert, wenn der
   Block die `:logseq.property.asset/checksum`-Property gesetzt
   bekommt. Synchron zur Asset-Binary-Persistierung in OPFS.

### 5.3 Patch-Budget-Auswirkung

Aktueller Stand nach Phase 1.6 + 1.6.1 Sign-off: **6/20**.

| VA-Befund | Eingriff nötig? | Upstream-Patch ja/nein |
|---|---|---|
| VA1 (Lazy ✅) | keiner | 0 |
| VA2 (Eviction nachgerüstet in 1.6.1) | Hypha-eigen, kein Upstream | **0** |
| VA3 (kein Range) | Phase 2+ (Architektur-Switch nötig, siehe §6 U30) | dann: +2-3 Patches in Adapter + Frontend |
| VA4 (Upload ✅) | keiner — `proxy.ts` deckt alle Methoden bereits ab | **0** |

**Explizit bestätigt:** Asset-Upload-Pfad ist bereits funktional durch
die existierende `/assets/*`-Proxy-Definition (M8) ohne Method-Filter.
Kein Patch-Inventar-Wachstum nötig für Cross-Browser-Asset-Sync.

**Phase 1.6.1 hat 0 Patches addiert** — U31-Eviction lebt in
`frontend.hypha.asset-cache`, einem Hypha-eigenen Namespace ohne
Upstream-Berührung.

## 6. Phase-2-Optionen mit Use-Cases

Falls Asset-Optimierungen in einer späteren Phase (1.6.2 / 2.x)
adressiert werden, folgen sie der Use-Cases-Konvention:

### U30 — HTTP-Range-Support für große Assets (Phase 2)

**Status:** Verschoben in Phase 2 nach tieferer Architektur-Analyse.

**Beschreibung:** Browser kann eine PDF/Video-Datei progressive
laden, statt sie komplett vor Sichtbarkeit zu fetchen.

**Konkret:** `GET /assets/<id>.pdf` mit `Range: bytes=0-1048575`
liefert die erste 1 MB als `206 Partial Content` + `Content-Range:
bytes 0-1048575/82345678`. PDF.js zeigt Seite 1 sobald das genügt.

**Warum nicht Phase 1.6.1:**

Der ursprüngliche U30-Plan ("~15-20 LoC Upstream-Patch in
`handle-get-asset`") adressiert nur die **Server-Seite**, aber der
heutige Frontend-Code würde Range-Requests gar nicht senden:

| Code-Pfad heute | Was passiert |
|---|---|
| `asset-cp :did-mount` (`block.cljs:1098`) → `download-remote-asset!` | `js/fetch` ohne Range-Header → `.arrayBuffer()` → ganze Datei in OPFS |
| `asset-link` rendered `<img>/<video>/<embed>` | `<make-asset-url>` (`handler/assets.cljs:117`) baut `blob:`-URL via `URL.createObjectURL` aus OPFS-Bytes |
| Browser-interne Range-Requests (PDF.js, `<video>`) | Gehen gegen die `blob:`-URL → lesen direkt aus dem Memory-Buffer, **kein HTTP-Roundtrip** |

Server-Range alleine ist heute funktional totes Feature. Range würde
nur greifen, wenn das Frontend `<embed src="http://localhost:3030/assets/...">`
direkt setzt (Cache-bypass), und das wirft drei Folge-Probleme auf:

1. **Auth-Vector:** `<embed src>`/`<video src>` schickt keinen
   `Authorization: Bearer`-Header. Adapter braucht entweder
   Cookie-Auth für `/assets/`-GET (~15 LoC + Test) oder ein
   Signed-URL-Pattern (~30 LoC + Token-Validation).
2. **Cache-Bypass:** Streaming bricht Offline-Verfügbarkeit für die
   großen Files. Akzeptabel als Trade-Off, aber Trade-Off muss
   explizit sein.
3. **Threshold-Logik:** Wann Streaming, wann OPFS? Per Size? Per
   Mime-Type? Was bei Range-Failure (Fallback)?

**Realistische Aufwandsschätzung:**
- Adapter Range-Support: ~15 LoC = **Patch #7**
- Adapter Cookie-Auth bzw. Signed-URL: ~15-30 LoC = **Patch #8**
- Frontend Threshold + skip-cache + direct-URL: ~25-40 LoC = **Patch #9**
- Tests: ~50 LoC Adapter + Frontend

→ +2-3 Patches, ~80-100 LoC, neuer Auth-Vector. Das ist eigene
Mini-Phase, nicht U31-Beipack. Wenn realisiert, dann als Phase 1.7
(asset-streaming) oder konsolidiert mit U21 (Realtime) als
Phase 2-Material.

### U31 — Asset-Cache-Eviction bei Quota-Druck (implementiert in Phase 1.6.1)

**Status:** Implementiert. Siehe
[`phase-1.6.1-asset-cache.md`](./phase-1.6.1-asset-cache.md).

**Implementation:**
- Hypha-eigener Namespace `frontend.hypha.asset-cache`, kein
  Upstream-Patch.
- LRU via LightningFS `mtimeMs` (Surrogat für last-access; Assets sind
  write-once).
- Reactive Background-Loop alle 30 s, trigger bei `usage/quota > 0.8`,
  evict bis `<= 0.6`.
- Enumeration via `window.pfs` (worker-proxied LightningFS-Bridge via
  MagicPortal/Comlink), Quota via `navigator.storage.estimate()`.

### Use Cases bewusst nicht adressiert (Phase 3+ oder nie)

- **U32**: CDN-Caching mit `Cache-Control: max-age=...` für Assets.
  Würde Bandbreite reduzieren bei Multi-Device-Repeat-Access, aber
  bricht E2EE-Use-Case (verschlüsselte Asset-Bytes müssen pro Request
  decryptbar bleiben).
- **U33**: Pre-Fetch bei Sichtbar-Werden im Viewport (Intersection
  Observer). Würde die Latenz minimal verkürzen; Lazy-on-Mount ist
  aber schon nahe genug.

## 7. Sign-off

| Frage | Antwort | Beleg |
|---|---|---|
| Lazy oder Eager? | **Lazy on Block-Mount** | VA1 Code-Belege (7 Stufen) |
| Cache existiert? | **Ja, LightningFS auf IndexedDB pro Graph (`logseq`-DB)** | VA2 §2 |
| Eviction? | **Ja, in Phase 1.6.1 — LRU via mtime, 30 s background tick, 80% Quota-Trigger** | VA2 §2 + [`phase-1.6.1-asset-cache.md`](./phase-1.6.1-asset-cache.md) |
| Range-Support? | **Nein. Architektur-Switch erforderlich (Phase 2)** | VA3 §3 + §6 U30 |
| Upload sofort? | **Ja, async pro Tx, parallelism 10** | VA4 §4.1 |
| Proxy alle Methoden? | **Ja, GET/PUT/DELETE/OPTIONS** | VA4 §4.2 |
| Cross-Browser-Asset-Sync funktional? | **Ja, kein Patch nötig** | M8 + VA4 |

**Stand:** Hypha-Phase-1.6 erfüllt Asset-Sync end-to-end; Phase 1.6.1
ergänzt Eviction. Range-Support bleibt Phase-2-Material wegen
Architektur-Switch (Auth-Vector + Streaming-Path).
