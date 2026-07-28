/**
 * PWA surface: web manifest + quick-capture share target.
 *
 * Two Hypha additions live here, both additive (no upstream-Logseq patch):
 *
 *   1. GET /manifest.webmanifest — makes the self-hosted frontend a real
 *      installable PWA (Homescreen icon, standalone window). Stock Logseq
 *      ships no manifest at all, so "Install app" in Chrome only ever
 *      produced a bookmark-style shortcut.
 *
 *   2. The manifest's `share_target` — Android's share sheet posts the
 *      shared page into the app as query params, which the frontend
 *      (frontend.hypha.capture) turns into a quick-capture block. The
 *      same query-param contract backs the desktop bookmarklet.
 *
 * The link tag pointing at the manifest is injected into index.html by
 * statics.ts rather than committed into resources/index.html, to keep the
 * upstream tree untouched (see HYPHA_PATCHES.md threshold discipline).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A throwaway static root holding a stand-in for the built index.html. */
async function makeStaticDir(indexHtml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hypha-statics-"));
  await writeFile(join(dir, "index.html"), indexHtml, "utf8");
  return dir;
}

const MINIMAL_INDEX = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Logseq</title>
</head>
<body><div id="root"></div></body>
</html>
`;

test("GET /manifest.webmanifest — served with the manifest MIME type", async () => {
  const app = await buildApp({ config: await makeRuntime(), logLevel: "silent" });
  const res = await app.inject({ method: "GET", url: "/manifest.webmanifest" });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /application\/manifest\+json/);
  await app.close();
});

test("manifest carries the fields Chrome requires for installability", async () => {
  const app = await buildApp({ config: await makeRuntime(), logLevel: "silent" });
  const res = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  const manifest = res.json();

  assert.equal(manifest.name, "Hypha");
  assert.equal(manifest.short_name, "Hypha");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");

  // Chrome's install gate needs a PNG icon of at least 192x192.
  // resources/img/logo.png is exactly 192x192 and ships in static/.
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  const icon = manifest.icons.find((i: { sizes: string }) => i.sizes === "192x192");
  assert.ok(icon, "expected a 192x192 icon entry");
  assert.equal(icon.src, "/img/logo.png");
  assert.equal(icon.type, "image/png");
  await app.close();
});

test("manifest declares a GET share_target using the hypha-* param contract", async () => {
  const app = await buildApp({ config: await makeRuntime(), logLevel: "silent" });
  const manifest = (await app.inject({ method: "GET", url: "/manifest.webmanifest" })).json();

  // GET (not POST) keeps the whole capture path client-side: the browser
  // navigates to start_url with the shared fields as query params, and
  // frontend.hypha.capture picks them up. No server-side graph write —
  // the graph lives in the browser's OPFS and syncs over RTC.
  assert.equal(manifest.share_target.action, "/");
  assert.equal(manifest.share_target.method, "GET");
  assert.deepEqual(manifest.share_target.params, {
    title: "hypha-title",
    text: "hypha-text",
    url: "hypha-url",
  });
  await app.close();
});

test("GET / — index.html is served with the manifest link injected", async () => {
  const staticDir = await makeStaticDir(MINIMAL_INDEX);
  const app = await buildApp({ config: await makeRuntime(), staticDir, logLevel: "silent" });

  const res = await app.inject({ method: "GET", url: "/" });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.ok(
    res.body.includes('<link rel="manifest" href="/manifest.webmanifest">'),
    "expected the manifest link tag in the served index.html",
  );
  // The upstream markup must survive untouched.
  assert.ok(res.body.includes('<div id="root"></div>'));
  await app.close();
});

test("GET /index.html — same injection as GET /", async () => {
  const staticDir = await makeStaticDir(MINIMAL_INDEX);
  const app = await buildApp({ config: await makeRuntime(), staticDir, logLevel: "silent" });

  const res = await app.inject({ method: "GET", url: "/index.html" });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<link rel="manifest" href="/manifest.webmanifest">'));
  await app.close();
});

test("injection is not duplicated when index.html already links a manifest", async () => {
  const staticDir = await makeStaticDir(
    MINIMAL_INDEX.replace("<title>", '<link rel="manifest" href="/manifest.webmanifest">\n  <title>'),
  );
  const app = await buildApp({ config: await makeRuntime(), staticDir, logLevel: "silent" });

  const res = await app.inject({ method: "GET", url: "/" });

  const occurrences = res.body.split('rel="manifest"').length - 1;
  assert.equal(occurrences, 1, "manifest link must appear exactly once");
  await app.close();
});

test("other static files are still served normally", async () => {
  const staticDir = await makeStaticDir(MINIMAL_INDEX);
  await writeFile(join(staticDir, "app.css"), "body{}", "utf8");
  const app = await buildApp({ config: await makeRuntime(), staticDir, logLevel: "silent" });

  const res = await app.inject({ method: "GET", url: "/app.css" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "body{}");
  await app.close();
});
