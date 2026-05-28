/**
 * Integration tests for the /plugin-market/* and /plugin-cdn/r2/* caching
 * reverse-proxy routes.
 *
 * Each test spins up
 *   - a fake upstream HTTP server (stand-in for raw.githubusercontent.com
 *     or plugins.logseq.io), with scriptable per-path responses + call
 *     count, and
 *   - a real hypha-server app built with `pluginUpstream` pointed at the
 *     fake.
 *
 * We use Fastify's `inject()` instead of binding a TCP port for the hypha
 * app — only the fake upstream needs a real port (the route handler
 * fetches it via the built-in `globalThis.fetch`).
 *
 * Verifies:
 *   - Cache HIT/MISS/BYPASS markers on `X-Hypha-Cache`.
 *   - Cache reduces upstream call count to 1 across repeated requests.
 *   - Content-type passthrough for binary and JSON.
 *   - Path-traversal rejection on the packages/* and r2/* wildcards.
 *   - Upstream 404 propagates and is NOT cached.
 *   - Upstream unreachable returns 502 `{ error: "upstream_unreachable" }`.
 *   - /health?detail=cache surfaces cache stats; /health stays minimal.
 *   - Routes are skipped entirely when `pluginUpstream` is not supplied.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http, { type AddressInfo } from "node:http";
import bcrypt from "bcryptjs";
import { generateKeyPair, exportJWK } from "jose";

import { buildApp } from "../src/app.ts";
import type { HyphaRuntime } from "../src/config.ts";

async function makeRuntime(): Promise<HyphaRuntime> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "hypha-test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  return {
    port: 0,
    host: "127.0.0.1",
    username: "hypha-user",
    userUuid: "00000000-0000-0000-0000-000000000001",
    email: "user@hypha.test",
    accessCodeHash: await bcrypt.hash("ignored", 4),
    jwtIssuer: "https://hypha.test/issuer",
    jwtAudience: "hypha-test-audience",
    jwtTtl: "1h",
    sessionTtlSeconds: 3600,
    cookieSecure: false,
    signingKid: "hypha-test-key",
    staticDirs: [],
    dbSyncInternalPort: 0,
    dataDir: "/tmp/hypha-test-data",
    signingPrivateKey: privateKey,
    signingPublicJwk: publicJwk,
  };
}

interface FakeResponse {
  status?: number;
  contentType?: string;
  /** Either a UTF-8 string body or a raw Buffer. */
  body: string | Buffer;
}

interface FakeUpstream {
  url: string;
  /** Records every request path in arrival order. */
  calls: string[];
  /** Map of exact URL path → response to send. Missing path → 404. */
  responses: Map<string, FakeResponse>;
  close: () => Promise<void>;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const calls: string[] = [];
  const responses = new Map<string, FakeResponse>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    calls.push(url);
    const planned = responses.get(url);
    if (!planned) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(planned.status ?? 200, {
      "content-type": planned.contentType ?? "application/json",
    });
    res.end(planned.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    responses,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function buildPluginApp(
  market: FakeUpstream,
  cdn: FakeUpstream,
  cacheMaxEntries = 64,
  assets?: FakeUpstream,
) {
  const config = await makeRuntime();
  const app = await buildApp({
    config,
    logLevel: "silent",
    pluginUpstream: {
      marketBase: market.url,
      cdnBase: cdn.url,
      // Phase 1.6.2 added assetsBase. Tests that don't exercise the
      // /plugin-cdn/assets/* route may pass nothing — we point at the
      // cdn fake just to keep the type contract honest (the route only
      // fires if the test makes the matching request).
      assetsBase: assets?.url ?? cdn.url,
      cacheMaxEntries,
    },
  });
  return app;
}

test("/plugin-market/plugins.json — first request is MISS, second is HIT, upstream called once", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  market.responses.set("/plugins.json", {
    contentType: "application/json",
    body: JSON.stringify([{ id: "a" }, { id: "b" }]),
  });
  const app = await buildPluginApp(market, cdn);
  try {
    const r1 = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.headers["x-hypha-cache"], "MISS");
    assert.equal(r1.headers["content-type"], "application/json");
    assert.deepEqual(r1.json(), [{ id: "a" }, { id: "b" }]);

    const r2 = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.headers["x-hypha-cache"], "HIT");
    assert.deepEqual(r2.json(), [{ id: "a" }, { id: "b" }]);

    assert.equal(market.calls.length, 1, "upstream must be called exactly once");
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("/plugin-market/stats.json — separate cache key from plugins.json", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  market.responses.set("/stats.json", { body: JSON.stringify({ downloads: 42 }) });
  market.responses.set("/plugins.json", { body: "[]" });
  const app = await buildPluginApp(market, cdn);
  try {
    const r1 = await app.inject({ method: "GET", url: "/plugin-market/stats.json" });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.headers["x-hypha-cache"], "MISS");
    assert.deepEqual(r1.json(), { downloads: 42 });

    // plugins.json is a different cache key — also a MISS, separate upstream hit.
    const r2 = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(r2.headers["x-hypha-cache"], "MISS");
    assert.equal(market.calls.length, 2);
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("/plugin-market/packages/* — wildcard proxies + caches binary content with content-type passthrough", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  market.responses.set("/packages/foo/icon.png", {
    contentType: "image/png",
    body: png,
  });
  const app = await buildPluginApp(market, cdn);
  try {
    const r1 = await app.inject({ method: "GET", url: "/plugin-market/packages/foo/icon.png" });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.headers["content-type"], "image/png");
    assert.equal(r1.headers["x-hypha-cache"], "MISS");
    assert.deepEqual(r1.rawPayload, png);

    const r2 = await app.inject({ method: "GET", url: "/plugin-market/packages/foo/icon.png" });
    assert.equal(r2.headers["x-hypha-cache"], "HIT");
    assert.deepEqual(r2.rawPayload, png, "cached binary must round-trip byte-for-byte");
    assert.equal(market.calls.length, 1);
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("/plugin-market/packages/* — rejects path traversal with 400 invalid_path, no upstream call", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  const app = await buildPluginApp(market, cdn);
  try {
    const res = await app.inject({
      method: "GET",
      url: "/plugin-market/packages/..%2Fetc%2Fpasswd",
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "invalid_path" });
    assert.equal(market.calls.length, 0, "no upstream fetch on path-traversal reject");
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("/plugin-cdn/r2/* — manifest + asset subpaths cached independently", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  cdn.responses.set("/debanjandhar12/logseq-anki-sync", {
    body: JSON.stringify({ name: "logseq-anki-sync", main: "dist/index.html" }),
  });
  const jsBytes = Buffer.from("console.log('plugin');", "utf8");
  cdn.responses.set("/debanjandhar12/logseq-anki-sync/dist/index.js", {
    contentType: "application/javascript",
    body: jsBytes,
  });
  const app = await buildPluginApp(market, cdn);
  try {
    const manifest = await app.inject({
      method: "GET",
      url: "/plugin-cdn/r2/debanjandhar12/logseq-anki-sync",
    });
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.headers["x-hypha-cache"], "MISS");
    assert.equal((manifest.json() as { main: string }).main, "dist/index.html");

    const asset = await app.inject({
      method: "GET",
      url: "/plugin-cdn/r2/debanjandhar12/logseq-anki-sync/dist/index.js",
    });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers["content-type"], "application/javascript");
    assert.deepEqual(asset.rawPayload, jsBytes);

    // Second hit on the manifest only — asset is independent.
    const manifest2 = await app.inject({
      method: "GET",
      url: "/plugin-cdn/r2/debanjandhar12/logseq-anki-sync",
    });
    assert.equal(manifest2.headers["x-hypha-cache"], "HIT");
    assert.equal(cdn.calls.length, 2, "manifest + asset = 2 distinct upstream fetches");
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("/plugin-cdn/r2/* — rejects path traversal with 400 invalid_path", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  const app = await buildPluginApp(market, cdn);
  try {
    const res = await app.inject({ method: "GET", url: "/plugin-cdn/r2/..%2Fsecret" });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "invalid_path" });
    assert.equal(cdn.calls.length, 0);
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

// Phase 1.6.2: /plugin-cdn/assets/* must inject cross-origin-resource-policy
// so plugin iframes pass Hypha's COEP=credentialless gate.

test("/plugin-cdn/assets/* — injects cross-origin-resource-policy on MISS, HIT, and BYPASS", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  const assets = await startFakeUpstream();
  const htmlBytes = Buffer.from("<!doctype html><html><body>plugin</body></html>", "utf8");
  assets.responses.set("/gidongkwon/logseq-plugin-tags/v0.1.2/dist/index.html", {
    contentType: "text/html",
    body: htmlBytes,
  });
  const app = await buildPluginApp(market, cdn, 64, assets);
  try {
    // MISS — first request fetches upstream and sets the header.
    const miss = await app.inject({
      method: "GET",
      url: "/plugin-cdn/assets/gidongkwon/logseq-plugin-tags/v0.1.2/dist/index.html",
    });
    assert.equal(miss.statusCode, 200);
    assert.equal(miss.headers["cross-origin-resource-policy"], "cross-origin",
      "MISS response must carry CORP=cross-origin so COEP credentialless passes");
    assert.equal(miss.headers["x-hypha-cache"], "MISS");
    assert.deepEqual(miss.rawPayload, htmlBytes);

    // HIT — second request hits cache and must STILL set the header (cache
    // re-emit, not just on-the-wire-fetch).
    const hit = await app.inject({
      method: "GET",
      url: "/plugin-cdn/assets/gidongkwon/logseq-plugin-tags/v0.1.2/dist/index.html",
    });
    assert.equal(hit.headers["cross-origin-resource-policy"], "cross-origin",
      "HIT response must also carry CORP — the gate is on every reply, not just upstream-touched ones");
    assert.equal(hit.headers["x-hypha-cache"], "HIT");
    assert.equal(assets.calls.length, 1, "second hit must come from cache, not upstream");

    // BYPASS — upstream 404 path must still set CORP so error pages don't
    // bypass the policy.
    const fourOhFour = await app.inject({
      method: "GET",
      url: "/plugin-cdn/assets/unknown/repo/v9.9.9/dist/missing.html",
    });
    assert.equal(fourOhFour.statusCode, 404);
    assert.equal(fourOhFour.headers["cross-origin-resource-policy"], "cross-origin",
      "BYPASS response must carry CORP — defense in depth, in case the browser surfaces the error page");
    assert.equal(fourOhFour.headers["x-hypha-cache"], "BYPASS");
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
    await assets.close();
  }
});

test("/plugin-cdn/assets/* — rejects path traversal with 400 invalid_path", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  const assets = await startFakeUpstream();
  const app = await buildPluginApp(market, cdn, 64, assets);
  try {
    const res = await app.inject({
      method: "GET",
      url: "/plugin-cdn/assets/..%2Fsecret",
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "invalid_path" });
    assert.equal(assets.calls.length, 0, "no upstream fetch on traversal reject");
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
    await assets.close();
  }
});

test("upstream 404 — propagates status, BYPASS marker, NOT cached", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  // No response registered for /plugins.json → fake returns 404.
  const app = await buildPluginApp(market, cdn);
  try {
    const r1 = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(r1.statusCode, 404);
    assert.equal(r1.headers["x-hypha-cache"], "BYPASS");

    const r2 = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(r2.statusCode, 404);
    assert.equal(r2.headers["x-hypha-cache"], "BYPASS",
      "404 must NOT poison the cache; second request must also reach upstream");
    assert.equal(market.calls.length, 2);
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("upstream unreachable — returns 502 upstream_unreachable", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  // Close the market upstream BEFORE building hypha so fetch fails.
  await market.close();
  const app = await buildPluginApp(market, cdn);
  try {
    const res = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "upstream_unreachable" });
  } finally {
    await app.close();
    await cdn.close();
  }
});

test("/health?detail=cache — exposes plugin-cache stats; bare /health stays minimal", async () => {
  const market = await startFakeUpstream();
  const cdn = await startFakeUpstream();
  market.responses.set("/plugins.json", { body: "[]" });
  const app = await buildPluginApp(market, cdn);
  try {
    // Drive 1 MISS + 1 HIT.
    await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });

    const detail = await app.inject({ method: "GET", url: "/health?detail=cache" });
    assert.equal(detail.statusCode, 200);
    const body = detail.json() as { status: string; cache: { hits: number; misses: number; size: number; maxSize: number; evictions: number } };
    assert.equal(body.status, "ok");
    assert.equal(body.cache.hits, 1);
    assert.equal(body.cache.misses, 1);
    assert.equal(body.cache.size, 1);
    assert.equal(body.cache.maxSize, 64);
    assert.equal(body.cache.evictions, 0);

    const plain = await app.inject({ method: "GET", url: "/health" });
    assert.deepEqual(plain.json(), { status: "ok" });
  } finally {
    await app.close();
    await market.close();
    await cdn.close();
  }
});

test("plugin routes skipped when buildApp() is called without pluginUpstream", async () => {
  const config = await makeRuntime();
  const app = await buildApp({ config, logLevel: "silent" });
  try {
    const market = await app.inject({ method: "GET", url: "/plugin-market/plugins.json" });
    assert.equal(market.statusCode, 404);

    const cdn = await app.inject({ method: "GET", url: "/plugin-cdn/r2/foo/bar" });
    assert.equal(cdn.statusCode, 404);

    // /health?detail=cache without pluginUpstream just returns the bare status,
    // so a curl-probe doesn't crash on a missing cache.
    const detail = await app.inject({ method: "GET", url: "/health?detail=cache" });
    assert.deepEqual(detail.json(), { status: "ok" });
  } finally {
    await app.close();
  }
});
