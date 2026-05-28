/**
 * Integration test for the reverse proxy.
 *
 * Spins up
 *   - a fake upstream HTTP server (stand-in for node-adapter) that echoes
 *     back request path + headers + body so we can verify what reached it,
 *   - a real hypha-server instance pointed at that fake upstream,
 *
 * and verifies that requests for /sync/*, /graphs/*, /e2ee/*, /assets/*
 * are forwarded with headers (notably `Authorization`) and bodies intact.
 * WebSocket-upgrade proxying is covered in the M4 headless smoke test
 * (Playwright); doing it here would require a separate ws-client dependency.
 *
 * Phase-1.6 (M8) added the /graphs, /e2ee, /assets prefixes. The /asset
 * (singular) prefix was a Phase-1 typo and is gone — see
 * docs/hypha/phase-1.6-cross-device.md §V8 for the diagnosis.
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

test("/assets/* — request is forwarded with query string preserved", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    // Frontend builds URLs like /assets/<graph-id>/<asset-uuid>.<ext>
    // (worker/sync/large_title.cljs:62); preserve query strings for
    // signed-URL flows.
    const res = await fetch(`${baseUrl}/assets/graph-abc/uuid-xyz.png?sig=xyz`, {
      headers: { Authorization: "Bearer test-jwt" },
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    assert.equal(call.url, "/assets/graph-abc/uuid-xyz.png?sig=xyz");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/graphs — GET is forwarded (the list-remote-graphs endpoint)", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    const res = await fetch(`${baseUrl}/graphs`, {
      headers: { Authorization: "Bearer test-jwt" },
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    assert.equal(call.method, "GET");
    assert.equal(call.url, "/graphs");
    assert.equal(call.headers["authorization"], "Bearer test-jwt");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/graphs/<id>/members — POST body forwarded intact", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    const payload = JSON.stringify({ email: "x@y.z", role: "member" });
    const res = await fetch(`${baseUrl}/graphs/some-uuid/members`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-jwt" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/graphs/some-uuid/members");
    assert.equal(call.body, payload);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/e2ee/* — request is forwarded (RSA key management)", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    const res = await fetch(`${baseUrl}/e2ee/user-keys`, {
      headers: { Authorization: "Bearer test-jwt" },
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]!.url, "/e2ee/user-keys");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("X-Forwarded-Host + X-Forwarded-Proto are injected on every proxied path", async () => {
  // Phase 1.6 V10-click bug: db-sync's snapshot-stream-url uses
  // request.url.origin to embed a follow-up URL in its JSON response.
  // Behind hypha-server's reverse proxy, that origin equals the
  // container-internal loopback (127.0.0.1:8787), unreachable from the
  // browser. Fix: hypha-server injects X-Forwarded-Host + X-Forwarded-Proto
  // so the downstream service can reconstruct the public origin.
  // This test is the drift gate: removing the injection regresses every
  // browser fetch of /sync/.../snapshot/download.
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  // baseUrl is the hypha-server's listening host (e.g. "http://127.0.0.1:54321").
  // The browser-visible Host header equals baseUrl's host, NOT the upstream's.
  // After rewrite, upstream must see x-forwarded-host==browser-host.
  const expectedHost = new URL(baseUrl).host;
  try {
    for (const path of ["/sync/x", "/graphs", "/e2ee/user-keys", "/assets/x"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: "Bearer test-jwt" },
      });
      assert.equal(res.status, 200);
    }
    assert.equal(upstream.calls.length, 4);
    for (const call of upstream.calls) {
      // The drift gate: x-forwarded-host MUST be the browser-visible
      // hypha-server host, not the upstream's loopback host. If our
      // rewriteRequestHeaders hook regresses (or fastify-http-proxy
      // changes signature), this fails.
      assert.equal(
        call.headers["x-forwarded-host"],
        expectedHost,
        `x-forwarded-host wrong on ${call.url}; want ${expectedHost}`,
      );
      assert.equal(
        call.headers["x-forwarded-proto"],
        "http",
        `x-forwarded-proto wrong on ${call.url}`,
      );
    }
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("X-Forwarded-Host overrides the Host header that fastify-http-proxy already rewrote to upstream", async () => {
  // Phase-1.6 V10-final-click-bug regression test: by the time
  // @fastify/reply-from calls rewriteRequestHeaders, the Host header in
  // the `base` map has already been rewritten to the upstream's host.
  // Our hook must read host from the ORIGINAL FastifyRequest.headers,
  // not from `base`. If a future refactor reads from `base` again, this
  // test breaks immediately — that was the failure mode that caused
  // db-sync's snapshot-stream-url to embed the internal loopback host
  // in JSON responses, breaking cross-device graph downloads.
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  const expectedHost = new URL(baseUrl).host;
  const upstreamHost = new URL(upstream.url).host;
  // Sanity: the two hosts are distinct (different ports), so a stale
  // host read would produce a detectable error.
  assert.notEqual(expectedHost, upstreamHost);
  try {
    await fetch(`${baseUrl}/sync/snapshot/download`, {
      headers: { Authorization: "Bearer t" },
    });
    assert.equal(upstream.calls.length, 1);
    assert.equal(
      upstream.calls[0]!.headers["x-forwarded-host"],
      expectedHost,
      `x-forwarded-host must be the browser-facing host (${expectedHost}), not the upstream host (${upstreamHost})`,
    );
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("X-Forwarded-Host pre-set by an outer proxy is preserved (not overridden)", async () => {
  // When an operator fronts hypha-server with Caddy/nginx/Traefik on
  // TLS, THAT outer proxy should set x-forwarded-host=public-domain and
  // x-forwarded-proto=https. We must respect those, not overwrite with
  // the value of the (loopback) Host header from inside the operator's
  // network.
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    await fetch(`${baseUrl}/sync/x`, {
      headers: {
        Authorization: "Bearer t",
        "x-forwarded-host": "hypha.example.com",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]!.headers["x-forwarded-host"], "hypha.example.com");
    assert.equal(upstream.calls[0]!.headers["x-forwarded-proto"], "https");
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("/health — local route, NOT proxied (precedence over upstream)", async () => {
  const upstream = await startFakeUpstream();
  const { app, baseUrl } = await startHyphaWith(upstream.url);
  try {
    // /health is a hypha-server local route, must not be forwarded.
    // Phase-1.6 §V7 — this also implicitly verifies that the new
    // /graphs, /e2ee, /assets prefix routes don't shadow exact local routes.
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
    // All four proxy prefixes share a single syncUpstreamUrl gate in
    // app.ts:104. Verify each one is absent when the gate is off.
    for (const path of ["/sync/anything", "/graphs", "/e2ee/user-keys", "/assets/x"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, `expected 404 for ${path} when no upstream`);
    }
  } finally {
    await app.close();
  }
});
