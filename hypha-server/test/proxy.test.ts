/**
 * Integration test for the /sync + /asset reverse proxy.
 *
 * Spins up
 *   - a fake upstream HTTP server (stand-in for node-adapter) that echoes
 *     back request path + headers + body so we can verify what reached it,
 *   - a real hypha-server instance pointed at that fake upstream,
 *
 * and verifies that requests for /sync/* and /asset/* are forwarded with
 * headers (notably `Authorization`) and bodies intact. WebSocket-upgrade
 * proxying is covered in the M4 headless smoke test (Playwright); doing
 * it here would require a separate ws-client dependency.
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

interface FakeUpstreamCall {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startFakeUpstream(): Promise<{
  url: string;
  calls: FakeUpstreamCall[];
  close: () => Promise<void>;
}> {
  const calls: FakeUpstreamCall[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      calls.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echoed: { url: req.url, body } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startHyphaWith(syncUpstreamUrl: string) {
  const config = await makeRuntime();
  const app = await buildApp({ config, syncUpstreamUrl, logLevel: "silent" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

test("/sync/* — GET is forwarded to upstream with Authorization header preserved", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    const res = await fetch(`${baseUrl}/sync/graph-abc/foo`, {
      headers: { Authorization: "Bearer test-jwt-123" },
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    assert.equal(call.method, "GET");
    assert.equal(call.url, "/sync/graph-abc/foo");
    assert.equal(call.headers["authorization"], "Bearer test-jwt-123");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/sync/* — POST body is forwarded intact", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    const payload = JSON.stringify({ tx: ["a", "b", "c"] });
    const res = await fetch(`${baseUrl}/sync/graph-abc/tx`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-jwt" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/sync/graph-abc/tx");
    assert.equal(call.body, payload);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/asset/* — request is forwarded with query string preserved", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    const res = await fetch(`${baseUrl}/asset/abc.png?sig=xyz`, {
      headers: { Authorization: "Bearer test-jwt" },
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    assert.equal(call.url, "/asset/abc.png?sig=xyz");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/auth/* — auth endpoints are NOT proxied, /sync prefix is", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    // /health is a hypha-server local route, must not be forwarded.
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 0, "upstream must not see /health");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("proxy is skipped when buildApp() is called without syncUpstreamUrl", async () => {
  const config = await makeRuntime();
  const app = await buildApp({ config, logLevel: "silent" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sync/anything`);
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});
