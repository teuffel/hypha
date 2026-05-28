# Phase 1.6.1 — Asset Cache LRU Eviction

**Status:** Abgeschlossen 2026-05-28
**Vorgänger:** Phase 1.6 (Cross-Device Personal Cloud) — abgeschlossen
**Nachfolger:** Phase 2 (Multi-User + Realtime-Collab); U30 (HTTP-Range)
verschoben in Phase 2, siehe `asset-lazy-loading.md` §6.
**Reference:** `asset-lazy-loading.md` §2 (VA2-Befund: Cache wächst
monoton ohne Eviction).

**Terminologie-Klärung:** Logseq's Asset-Cache liegt in einer
LightningFS-Database (`logseq`) auf IndexedDB, mounted unter
`memory:///` — nicht in echtem OPFS. Die SQLite-DBs leben in OPFS
(via SAH-Pool), aber Asset-Binaries leben in IDB. Diese Phase
adressiert die IDB-Files. Der gemeinsame Browser-Quota-Pool
(`navigator.storage.estimate()`) umfasst beide, weshalb Eviction von
IDB-Asset-Files den `usage`-Report runterzieht.

## 0. Warum 1.6.1

VA2 aus der Asset-Lazy-Loading-Verifikation hat dokumentiert: Logseq's
Asset-Cache (LightningFS auf IDB) hat **keinen Eviction-Mechanismus**.
`asset-delete!` wird ausschließlich durch `:remove-asset`-Ops aus dem
Server-Tx-Stream getriggert — also nur, wenn der Server explizit
"Asset gelöscht" sagt.

Bei einem Personal-Cloud-Setup mit jahrelangem Use-Case und vielen
Anhängen führt das zu monotoner IDB-Inflation. Der Browser-Quota
(typischerweise 50–80% der Disk, gemeinsam für IDB + OPFS + Cache-API
+ ServiceWorker) wird irgendwann erreicht; die nächste
Asset-Write-Operation schlägt mit `QuotaExceededError` fehl. Aktuell
gibt es keinen Recovery-Pfad außer manuellem IDB-Leeren oder
Graph-Re-Download.

## 1. Scope

### 1.1 Use Cases

| Use Case | Beschreibung | Erfüllt in |
|---|---|---|
| **U31** | Asset-Cache-Eviction bei Quota-Druck — älteste Asset-Files automatisch löschen, wenn Browser-Storage-Quota knapp wird | Phase 1.6.1 (diese Datei) |

### 1.2 Out-of-Scope

| Use Case | Phase | Warum nicht 1.6.1 |
|---|---|---|
| **U30** | HTTP-Range-Support für große Assets | Phase 2 | Erfordert Architektur-Switch: heute lädt das Frontend Assets blob-first aus OPFS (`<make-asset-url>` → `URL.createObjectURL`); Range-Requests gehen nur dann gegen den Server, wenn `<embed src>`/`<video src>` direkt auf eine HTTP-URL zeigt. Das wiederum setzt einen anderen Auth-Vector voraus (`<embed>` schickt keinen `Authorization: Bearer`-Header) — Cookie-Auth für `/assets/`-GET oder Signed-URL-Pattern. ~80–100 LoC + neuer Auth-Pfad, eigene Mini-Phase. Siehe `asset-lazy-loading.md` §6. |
| **Auto-cleanup über alle Graphen-DBs** | Phase 2 | Datascript-DB-Eviction (z.B. archivierte Graphen) erfordert eigene Semantik (Confirm-Dialog, Recovery-Pfad). 1.6.1 evicted nur Asset-Binaries. |
| **User-Setting für Trigger/Target-Percent** | Phase 2 (wenn überhaupt) | Defaults sollen funktionieren ohne UX-Knöpfe; per-User-Konfiguration ist Phase-2-Material falls Heuristik nicht reicht. |

### 1.3 Architektur-Constraints

- **0 Upstream-Patches.** Phase 1.6 endete bei 6/20; Phase 1.6.1
  bleibt bei 6/20. U31 lebt als Hypha-eigener Namespace
  (`frontend.hypha.asset-cache`).
- **Keine Worker-Code-Änderung.** Der Eviction-Loop läuft im Frontend
  und nutzt `window.pfs` (worker-proxied LightningFS via Comlink). Das
  hält die Worker-und-Frontend-Separation-Regel ein.
- **Reactive statt proactive.** Eviction läuft als Background-Interval
  (30 s tick), nicht als synchroner Hook vor `download-remote-asset!`.
  Synchroner Hook würde einen Upstream-Patch in
  `worker/sync/assets.cljs` erfordern. 30 s ist für typische
  Quota-Größen (GB-Range) ausreichend schnell — ein 100 MB-Upload
  dauert minutenlang.
- **`mtimeMs` als LRU-Surrogat.** Wir tracken keine eigenen
  access-timestamps; LightningFS `stat.mtimeMs` reicht. "Modified" ist
  nicht identisch zu "accessed", aber für Assets gilt: einmal
  geschrieben, bleiben sie unverändert. → LRU-by-mtime ≈
  LRU-by-first-access.

## 2. Design

### 2.1 Heuristik

1. Tick alle 30 s.
2. `navigator.storage.estimate()` → `{usage, quota}` (Browser-weite
   IDB + OPFS + Cache-API + ServiceWorker-Summe).
3. Wenn `usage / quota < 0.8` → no-op.
4. Sonst: enumeriere alle Asset-Files quer über alle Graph-Roots in
   `window.pfs` (LightningFS), sortiere by `mtimeMs` ascending, lösche
   älteste bis `usage / quota <= 0.6` (60 % target).
5. Log alle Evictions zur Diagnostizierbarkeit
   (`:hypha/asset-cache-evicted`).

Trigger-Threshold 80 % gibt Headroom für laufende Asset-Uploads.
Target 60 % gibt Headroom für mehrere Eviction-Rounds, ohne ständig
zu thrashen.

### 2.2 Code-Lokation

- **Neuer Namespace:** `src/main/frontend/hypha/asset_cache.cljs`
- **Hook:** `frontend.hypha.init/start!` ruft `(asset-cache/start!)`
  einmal beim Boot. Idempotent (`defonce`-guarded Interval-ID).
- **Test:** `src/test/frontend/hypha/asset_cache_test.cljs` — Unit-Test
  gegen die reine Auswahl-Logik (sort + accumulate-stop) mit einem
  in-memory pfs-Stub. `navigator.storage.estimate()` ist nicht in Node
  verfügbar, wird nicht getestet (die `<maybe-evict!`-Hülle bleibt
  ohne Unit-Test, der Eviction-Algorithmus selbst ist abgedeckt).

### 2.3 Risiken

| Risiko | Mitigation |
|---|---|
| `navigator.storage.estimate()` fehlt im Browser | `<storage-estimate>` returnt nil → Eviction no-op, lautlos. Browser ohne Storage-API ist Edge-Case (Firefox vor 57, Safari vor 11). Publishing-Builds haben kein `window.pfs` — separater no-op-Pfad. |
| Race: zwei Tabs evicten gleichzeitig dasselbe File | `.unlink` auf bereits gelöschtem File catched in `<evict-until!`-loop, ignoriert. |
| Eviction löscht ein gerade benötigtes Asset | Lazy-Reload via VA1: das nächste `asset-cp :did-mount` triggert `download-remote-asset!`. User sieht kurz Spinner, dann Asset. Akzeptable Trade-Off. |
| Background-Loop verbraucht CPU | 30 s tick + skip-when-quota-OK heißt: 99 % der Ticks sind reine `navigator.storage.estimate()`-Calls (≪ 1 ms). |

## 3. Sign-off

| # | Kriterium | Status |
|---|---|---|
| 1 | `frontend.hypha.asset-cache` namespace existiert (163 LoC, davon ~50 docstring + ~110 Code) | ✅ |
| 2 | `frontend.hypha.init/start!` ruft `asset-cache/start!` | ✅ |
| 3 | Unit-Test für `<evict-until!` sort+stop-condition (4 Tests in `src/test/frontend/hypha/asset_cache_test.cljs`) | ✅ Code compile clean; CI-Run erforderlich für tatsächlichen Test-Run (lokales Node 20 hat pre-existing `node:sqlite`-Block, CI hat Node 24) |
| 4 | `clojure -M:cljs compile app db-worker --config-merge '{:closure-defines {frontend.hypha.config/HYPHA-MODE true}}'` 0 warnings | ✅ app 16/16 compiled, db-worker 0/475, 0 warnings |
| 5 | `bb lint:carve` clean | ✅ |
| 6 | `bb lint:worker-and-frontend-separate` clean (asset-cache requires nur `logseq.common.config` + `lambdaisland.glogi` + `promesa.core`) | ✅ |
| 7 | `asset-lazy-loading.md` §2 + §6 aktualisiert (U31 implementiert, U30 → Phase 2 begründet, OPFS→IDB-Terminologie korrigiert) | ✅ |
| 8 | Patches-Inventar bleibt 6/20 | ✅ Hypha-eigener Namespace, kein Upstream-Touch |

**End-Inventar:** 6/20 (unverändert seit Phase 1.6 Sign-off).

**Erkannte Doku-Korrektur (Bonus):** Phase 1.6 sprach von "OPFS-Cache"
für Assets. Tatsächlich liegen Asset-Binaries in einer
LightningFS-IndexedDB-Database (`logseq`), nicht in echtem OPFS. SQLite
liegt in OPFS via SAH-Pool, Asset-Binaries via LightningFS in IDB. Die
gemeinsame Quota-Messung (`navigator.storage.estimate()`) bleibt
korrekt für Eviction; die Terminologie ist in
`asset-lazy-loading.md` §2 und §6 nachgezogen.
