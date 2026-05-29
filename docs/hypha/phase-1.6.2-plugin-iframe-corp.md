# Phase 1.6.2 — Plugin-iframe CORP Proxy + Loader Monkey-Patch

**Status:** Abgeschlossen 2026-05-28
**Vorgänger:** Phase 1.6.1 (Asset-Cache LRU Eviction) — abgeschlossen
**Nachfolger:** Phase 2 (Multi-User + Realtime-Collab)
**Reference:** Phase 1.5 (Plugin-Marketplace) §1.5 "setup-global-apis-for-web!"
identifizierte schon die "zu lange zum Laden"-Symptom-Schicht;
diese Phase löst die unterliegende CORP-Mechanik.

## 0. Warum 1.6.2

Phase 1.5 hat den Marketplace operationalisiert: Plugin-JSON + R2-Manifest
werden via `/plugin-market/*` und `/plugin-cdn/r2/*` server-side gecached
und ausgeliefert. Phase 1.5 §1.5 hat dabei eine **noch ungelöste
Symptom-Schicht** dokumentiert ("zu lange zum Laden"-Warnungen mit
window.apis-Stubs als Patch).

V-Befund (2026-05-28, ein User mit 5 installierten Plugins): die wahre
Ursache ist die **Cross-Origin-Embedder-Policy-Interaktion**. Konkret:

1. Hypha-server setzt `cross-origin-embedder-policy: credentialless`
   (zwingend für SharedArrayBuffer → OPFS-SAH-Pool → Datascript-SQLite).
2. Web-Plugins werden in einem cross-origin `<iframe>` aus dem
   Cloudflare-R2-Asset-Bucket geladen: hardcoded in
   `libs/src/LSPlugin.core.ts:604-605` als
   `https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev/<repo>/<version>/...`.
3. Der R2-Bucket antwortet `200 OK` **ohne**
   `cross-origin-resource-policy: cross-origin` und **ohne**
   `access-control-allow-origin: *`.
4. COEP `credentialless` braucht eines der beiden, sonst blockt der
   Browser den iframe-Load komplett.
5. Plugin-Code läuft nie → kein `postmessage`-Handshake-Reply →
   `LSPlugin.caller.ts:296-303 HANDSHAKE_TIMEOUT = 8_000` greift →
   Console-Error alle 8 Sekunden, wiederholt sich.

Symptom in der User-Console (alle 8 s):
```
[PluginLocal][HH:MM:SS] ERROR: load:failed handshake Timeout
[PluginLocal][HH:MM:SS] ERROR: register: load failed handshake Timeout
```

Funktionsfolgen: alle installierten Web-Plugins (5 beim betroffenen
User: Tags, Bullet Threading, TODO Master, Vim Shortcuts, Automatic
Linker) sind effektiv tot. Sync-Funktion bleibt unbetroffen (Phase 1.6
hat das verifiziert via `:db-sync/upload-kvs-batch` Logs).

## 1. Scope

### 1.1 Use Cases

| Use Case | Beschreibung | Erfüllt in |
|---|---|---|
| **U40** | Installierte Web-Plugins laden in Hypha ohne handshake-Timeout, ohne dass der User per F12 in Plugin-Settings deaktivieren muss | Phase 1.6.2 |
| **U41** | Plugin-Bundle wird vom Hypha-Container gecached (Asset-TTL 24 h), funktioniert offline für bereits gesehene Plugins | Phase 1.6.2 (kommt via PluginCache-Wiederverwendung) |

### 1.2 Out-of-Scope

| Use Case | Phase | Warum nicht 1.6.2 |
|---|---|---|
| **U22 / U42** Plugin-Liste server-side persistieren (statt IndexedDB) | Phase 2 | Erfordert Multi-User-Identitäts-Modell. Phase 1.6.2 lässt Plugin-Liste in IDB wie Phase 1.5. |
| **U43** Plugin-Auto-Update bei Container-Restart | Phase 2 | Auto-Update läuft heute clientseitig (Logseq's eigener Check). Server-Push-Variante ist Phase-2-Material. |
| **U44** Plugin-Marketplace-Spiegel für Air-gapped-Setups | Phase 2 | Persistent-Disk-Cache + CLI-Sync (siehe Phase 1.5 §10). |

### 1.3 Architektur-Constraints

- **0 zusätzliche Upstream-Patches.** Phase 1.6 endete bei 8/20;
  Phase 1.6.2 bleibt bei 8/20. Die Plugin-Loader-Anpassung läuft als
  Runtime-Monkey-Patch in `frontend.hypha.plugin-init`, der bereits
  vorhandene Phase-1.5-Erweiterungspunkt.
- **COEP `credentialless` bleibt zwingend.** OPFS-SAH-Pool für
  Datascript-DB-Storage erfordert SharedArrayBuffer → COEP/COOP
  nicht abschaltbar.
- **Bestehender `PluginCache` wird wiederverwendet.** Phase 1.5 hat
  ihn bereits etabliert für Manifest + Plugin-Bundle. Asset-Files (CSS,
  JS, Bilder im iframe) kommen über denselben Cache, andere TTL.
- **Keine `lsplugin.core.js`-Rebuild.** Wir patchen NICHT
  `libs/src/LSPlugin.core.ts`; das Bundle bleibt unverändert. Der
  Monkey-Patch greift `window.LSPlugin.PluginLocal.prototype` zur
  Laufzeit, vor dem ersten `register([…])`.

## 2. Design

### 2.1 Server-Schicht: neue Route `/plugin-cdn/assets/*`

Erweiterung von `hypha-server/src/routes/plugin-cdn.ts` um einen
zweiten Endpoint:

```typescript
// GET /plugin-cdn/assets/<repo>/<version>/<path>
//   → proxies https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev/<repo>/<version>/<path>
//   adds  Cross-Origin-Resource-Policy: cross-origin
//   cache 24 h (gleiche TTL wie /plugin-cdn/r2/*)
```

`PluginCache` und `serveCached` werden um ein optionales
`extraHeaders`-Argument erweitert, sodass die CORP-Header beim Hit + Miss
identisch gesetzt werden.

### 2.2 Client-Schicht: Monkey-Patch in `plugin_init.cljs`

Phase 1.5 hat dort bereits `install-fetch-redirect!` etabliert (Fetch-Interception
für Marketplace-URLs). Wir ergänzen `install-plugin-asset-rewrite!`:

```clojure
(defn install-plugin-asset-rewrite!
  "Rewrites web-plugin iframe entry URLs from the upstream R2 bucket
   to the same-origin /plugin-cdn/assets/* proxy.

   The original PluginLocal._resolveResourceFullUrl returns
   https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev/<repo>/<ver>/<path>
   directly (LSPlugin.core.ts:604-605). Under hypha-server's required
   COEP=credentialless, cross-origin iframes without CORP headers are
   blocked, causing LSPlugin.caller.ts:296-303 handshake timeouts
   every 8 seconds."
  [])
```

Ablauf:
1. Idempotent guard via `.__hyphaWrapped` flag (analog Phase 1.5
   fetch-redirect).
2. Wartet asynchron bis `window.LSPlugin.PluginLocal` verfügbar
   (defer-loaded vor `main.js` in `resources/index.html:script-order`,
   sollte sofort da sein wenn cljs bundle bootet, mit Fallback-Watch).
3. Wrappt `proto._resolveResourceFullUrl`: bei R2-Bucket-Prefix
   ersetzt durch `/plugin-cdn/assets/...`.

Call-Site in `frontend.hypha.init/start!` direkt nach dem bestehenden
`plugin_init`-Aufruf (welches Phase-1.5 Stubs setzt).

### 2.3 ENV-Override

Analog `HYPHA_PLUGIN_MARKET_UPSTREAM` und `HYPHA_PLUGIN_CDN_UPSTREAM`:

```
HYPHA_PLUGIN_ASSETS_UPSTREAM=https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev
```

Default ist die R2-Bucket-URL. Override für CI-Tests (Mock-Upstream) oder
falls Logseq jemals den Bucket umzieht.

## 3. Risiken

| Risiko | Mitigation |
|---|---|
| R2-Bucket-Pfad-Struktur ändert sich | Default-URL als ENV-Override exposed; Anchor-Test via `rg` schlägt Alarm bei strukturellen Renames |
| `window.LSPlugin.PluginLocal.prototype` umbenannt durch upstream | Defensive `some->`-Chain + Log-Warnung wenn nicht gefunden, statt Hard-Fail (Plugin-Init-Pfad weiter funktional) |
| Plugin-Asset-Cache füllt RAM | Phase 1.5 hat LRU mit `cacheMaxEntries`; Asset-Files (~MB pro Plugin) drücken den Cache schneller. Default-Cap erhöhen wenn empirisch nötig |
| Patch-Idempotenz beim HMR | `__hyphaWrapped`-Flag verhindert Doppel-Wrapping, analog Phase 1.5 fetch-Redirect |
| Iframe-relative Sub-Resources gehen leer | iframe-Base-URL nach Rewrite = `/plugin-cdn/assets/...` (Hypha-Server), relative URLs darin (`assets/index-XYZ.js`) routen automatisch zurück durch den Proxy. Keine zusätzlichen Hooks nötig |

## 4. Sign-off

| # | Kriterium | Status |
|---|---|---|
| 1 | `hypha-server/src/routes/plugin-cdn.ts` exposed `/plugin-cdn/assets/*` mit CORP-Header | ✅ |
| 2 | `hypha-server/src/plugin-cache.ts` `serveCached` akzeptiert optional `extraHeaders` | ✅ |
| 3 | `hypha-server/src/app.ts` `pluginUpstream.assetsBase` config + Route-Registration | ✅ |
| 4 | `hypha-server/src/main.ts` ENV-Override `HYPHA_PLUGIN_ASSETS_UPSTREAM` mit R2-Default | ✅ |
| 5 | `src/main/frontend/hypha/plugin_init.cljs` `install-plugin-asset-rewrite!` mit idempotenter Wrap-Logic via `__hyphaWrapped`-Flag | ✅ |
| 6 | `setup!` ruft `install-plugin-asset-rewrite!` als dritten Schritt nach `install-fetch-redirect!` + `install-window-apis!` (alle drei laufen via `_on-load` defonce zur namespace-Load-Zeit, bevor `frontend.handler/start!` greift) | ✅ |
| 7 | `hypha-server/test/plugin-market-proxy.test.ts` erweitert mit 2 neuen Tests: CORP-Injection auf HIT/MISS/BYPASS und Path-Traversal-Reject für die assets-Route | ✅ 12/12 PASS |
| 8 | `pnpm --dir hypha-server build` + cljs compile (HYPHA-MODE=true): jeweils 0 warnings (nach `^js`-Type-Hint auf `proto`) | ✅ |
| 9 | `bb lint:carve`, `bb lint:worker-and-frontend-separate`, `bash .github/scripts/hypha-patch-anchors.sh`: alle grün | ✅ 9/9 anchors PASS |
| 10 | Patches-Inventar bleibt 8/20 | ✅ |
| 11 | Image-Rebuild + User-Test: alle 5 Plugins laden ohne handshake-Timeout | – (gleich) |

**End-Inventar:** 8/20 (unverändert seit Phase 1.6 Sign-off).
