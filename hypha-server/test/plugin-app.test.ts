/**
 * Tests for the plugin-origin isolation:
 *
 *   - buildPluginAssetsApp(): the separate-origin listener that serves
 *     /plugin-cdn/assets/* (and nothing auth-related).
 *   - statics: <meta> injection telling the frontend where that origin is.
 *   - parsePluginOrigin(): fail-fast env validation.
 *
 * Background: third-party plugin iframe documents used to be served from the
 * app origin, which let plugin code read /auth/session. They now live on
 * their own origin; these tests pin that boundary.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http, { type AddressInfo } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { generateKeyPair, exportJWK } from "jose";

import { buildApp } from "../src/app.ts";
import { buildPluginAssetsApp } from "../src/plugin-app.ts";
import { parsePluginOrigin, parsePort } from "../src/plugin-origin.ts";
import { injectPluginMeta, pluginMetaTag } from "../src/statics.ts";
import type { HyphaRuntime } from "../src/config.ts";

interface Fake {
  url: string;
  calls: string[];
  responses: Map<string, { contentType: string | null; body: Buffer }>;
  close: () => Promise<void>;
}

async function startFake(): Promise<Fake> {
  const calls: string[] = [];
  const responses: Fake["responses"] = new Map();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    calls.push(url);
    const planned = responses.get(url);
    if (!planned) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, planned.contentType === null ? {} : { "content-type": planned.contentType });
    res.end(planned.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    responses,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function makeRuntime(): Promise<HyphaRuntime> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "hypha-test-key";
  return {
    port: 0,
    host: "127.0.0.1",
    username: "hypha-user",
    userUuid: "00000000-0000-0000-0000-000000000001",
    email: "user@hypha.test",
    accessCodeHash: await bcrypt.hash("ignored", 4),
    jwtIssuer: "https://hypha.test",
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

const ISOLATION_HEADERS = {
  "cross-origin-resource-policy": "cross-origin",
  "cross-origin-embedder-policy": "credentialless",
  "x-content-type-options": "nosniff",
} as const;

test("plugin-assets app — serves + caches assets with iframe-embedding headers on MISS, HIT, BYPASS", async () => {
  const assets = await startFake();
  const html = Buffer.from("<!doctype html><html><body>plugin</body></html>", "utf8");
  assets.responses.set("/owner/repo/v1.0.0/dist/index.html", { contentType: "text/html", body: html });
  const app = await buildPluginAssetsApp({ assetsBase: assets.url, logLevel: "silent" });
  try {
    const url = "/plugin-cdn/assets/owner/repo/v1.0.0/dist/index.html";
    const miss = await app.inject({ method: "GET", url });
    const hit = await app.inject({ method: "GET", url });
    const bypass = await app.inject({ method: "GET", url: "/plugin-cdn/assets/owner/repo/v9/missing.html" });

    assert.equal(miss.statusCode, 200);
    assert.deepEqual(miss.rawPayload, html);
    assert.equal(miss.headers["x-hypha-cache"], "MISS");
    assert.equal(hit.headers["x-hypha-cache"], "HIT");
    assert.equal(bypass.statusCode, 404);
    assert.equal(bypass.headers["x-hypha-cache"], "BYPASS");
    assert.equal(assets.calls.length, 2, "HIT must not touch upstream");

    for (const res of [miss, hit, bypass]) {
      for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
        assert.equal(res.headers[name], value, `${name} on ${res.headers["x-hypha-cache"]}`);
      }
    }
  } finally {
    await app.close();
    await assets.close();
  }
});

test("plugin-assets app — sniffs Content-Type from extension when upstream omits it", async () => {
  // The real R2 bucket answers 200 without a Content-Type header.
  const assets = await startFake();
  assets.responses.set("/foo/bar/v1/dist/index.html", { contentType: null, body: Buffer.from("<p>x</p>") });
  assets.responses.set("/foo/bar/v1/dist/index.js", { contentType: null, body: Buffer.from("export default 1;") });
  const app = await buildPluginAssetsApp({ assetsBase: assets.url, logLevel: "silent" });
  try {
    const html = await app.inject({ method: "GET", url: "/plugin-cdn/assets/foo/bar/v1/dist/index.html" });
    const js = await app.inject({ method: "GET", url: "/plugin-cdn/assets/foo/bar/v1/dist/index.js" });
    assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(js.headers["content-type"], "application/javascript; charset=utf-8");
  } finally {
    await app.close();
    await assets.close();
  }
});

test("plugin-assets app — rejects plain and double-encoded path traversal without an upstream call", async () => {
  const assets = await startFake();
  const app = await buildPluginAssetsApp({ assetsBase: assets.url, logLevel: "silent" });
  try {
    for (const url of [
      "/plugin-cdn/assets/..%2Fsecret",
      // Double-encoded: survives the router's single decode as %2e%2e,
      // which fetch() would resolve as "..".
      "/plugin-cdn/assets/%252e%252e/elsewhere/index.html",
      "/plugin-cdn/assets/a/%252E%252e/b/index.html",
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      assert.deepEqual(res.json(), { error: "invalid_path" }, url);
    }
    assert.equal(assets.calls.length, 0);
  } finally {
    await app.close();
    await assets.close();
  }
});

test("plugin-assets app — needs no session (it never sees the cookie on its own hostname)", async () => {
  const assets = await startFake();
  assets.responses.set("/o/r/v1/index.js", { contentType: "application/javascript", body: Buffer.from("1") });
  const app = await buildPluginAssetsApp({ assetsBase: assets.url, logLevel: "silent" });
  try {
    for (const headers of [{}, { cookie: "hypha-session=not-a-session" }]) {
      const res = await app.inject({ method: "GET", url: "/plugin-cdn/assets/o/r/v1/index.js", headers });
      assert.equal(res.statusCode, 200);
    }
  } finally {
    await app.close();
    await assets.close();
  }
});

test("plugin-assets app — exposes no auth, sync or static surface and never sets cookies", async () => {
  const assets = await startFake();
  const app = await buildPluginAssetsApp({ assetsBase: assets.url, logLevel: "silent" });
  try {
    for (const [method, url] of [
      ["GET", "/auth/session"],
      ["POST", "/auth/login"],
      ["POST", "/auth/logout"],
      ["GET", "/auth/jwks"],
      ["GET", "/sync/x"],
      ["GET", "/graphs"],
      ["GET", "/"],
      ["GET", "/plugin-cdn/r2/x"],
      ["GET", "/plugin-market/plugins.json"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: "hypha-session=whatever" },
      });
      assert.equal(res.statusCode, 404, `${method} ${url}`);
      assert.equal(res.headers["set-cookie"], undefined, `${method} ${url}`);
    }
  } finally {
    await app.close();
    await assets.close();
  }
});

test("statics — index.html gets the plugin-origin meta tag; other files are served untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypha-statics-"));
  await writeFile(join(dir, "index.html"), "<!DOCTYPE html>\n<html><head>\n<title>x</title></head><body></body></html>");
  await writeFile(join(dir, "app.js"), "console.log(1)");
  const config = await makeRuntime();
  const byOrigin = await buildApp({
    config,
    logLevel: "silent",
    staticDir: dir,
    pluginFrontend: { origin: "https://plugins.hypha.test" },
  });
  const byPort = await buildApp({
    config,
    logLevel: "silent",
    staticDir: dir,
    pluginFrontend: { port: 3010 },
  });
  try {
    for (const url of ["/", "/index.html"]) {
      const res = await byOrigin.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers["content-type"]), /^text\/html/);
      assert.match(res.body, /<meta name="hypha-plugin-origin" content="https:\/\/plugins\.hypha\.test">\s*<\/head>/);
      assert.match(res.body, /<title>x<\/title>/);
    }
    const port = await byPort.inject({ method: "GET", url: "/" });
    assert.match(port.body, /<meta name="hypha-plugin-port" content="3010">/);
    assert.doesNotMatch(port.body, /hypha-plugin-origin/);

    const js = await byOrigin.inject({ method: "GET", url: "/app.js" });
    assert.equal(js.statusCode, 200);
    assert.equal(js.body, "console.log(1)");

    const missing = await byOrigin.inject({ method: "GET", url: "/nope.js" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await byOrigin.close();
    await byPort.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("statics helpers — attribute escaping, no-op without a location, fail-fast without </head>", () => {
  assert.equal(
    pluginMetaTag({ origin: 'https://x"><script>' }),
    '<meta name="hypha-plugin-origin" content="https://x&quot;&gt;&lt;script&gt;">',
  );
  assert.equal(pluginMetaTag(undefined), "");
  assert.equal(injectPluginMeta("<p>no head</p>", undefined), "<p>no head</p>");
  assert.throws(() => injectPluginMeta("<p>no head</p>", { port: 3010 }), /no <\/head>/);
  assert.equal(
    injectPluginMeta("<head><x></head>", { port: 3010 }),
    '<head><x>  <meta name="hypha-plugin-port" content="3010">\n</head>',
  );
});

test("parsePluginOrigin — normalises, and fails fast on unusable or same-origin values", () => {
  const app = "https://hypha.example.com";
  assert.equal(parsePluginOrigin(undefined, app), null);
  assert.equal(parsePluginOrigin("", app), null);
  assert.equal(parsePluginOrigin("https://plugins.hypha.example.com/", app), "https://plugins.hypha.example.com");
  assert.equal(parsePluginOrigin("http://localhost:3010", "http://localhost:3000"), "http://localhost:3010");

  assert.throws(() => parsePluginOrigin("https://hypha.example.com", app), /must differ from the app origin/);
  assert.throws(() => parsePluginOrigin("https://HYPHA.example.com:443/", app), /must differ from the app origin/);
  assert.throws(() => parsePluginOrigin("plugins.hypha.example.com", app), /not a valid URL/);
  assert.throws(() => parsePluginOrigin("ftp://plugins.example.com", app), /must be http\(s\)/);
  assert.throws(() => parsePluginOrigin("https://plugins.example.com/sub", app), /bare origin/);

  assert.equal(parsePort("X", "3010"), 3010);
  assert.throws(() => parsePort("X", "abc"), /integer port/);
  assert.throws(() => parsePort("X", "70000"), /integer port/);
});
