/**
 * Reverse-proxy for db-sync traffic.
 *
 * Browser ↔ hypha-server ↔ node-adapter (loopback :8787 by default).
 *
 *   /sync/*   — both HTTP and WebSocket; the browser sends WS upgrades with
 *               a `?token=<JWT>` query parameter, HTTP requests with an
 *               `Authorization: Bearer <JWT>` header. Both are forwarded
 *               verbatim and verified by node-adapter against the JWKS
 *               served at hypha-server's own /auth/jwks endpoint.
 *
 *   /graphs/* — HTTP only. Graph management: list, create, delete, members.
 *               Phase 1.6 (M8): added because cross-device requires the
 *               browser to be able to fetch its own remote graph list.
 *
 *   /e2ee/*   — HTTP only. End-to-end encryption key storage:
 *               user-keys (RSA pair, encrypted with user password),
 *               graph-aes-key, grant-access.
 *               Phase 1.6 (M8): required for the cross-device round-trip
 *               even when graph-e2ee is off — the frontend's
 *               <ensure-user-rsa-keys-on-server! still calls these endpoints
 *               unconditionally.
 *
 *   /assets/* — HTTP only (uploads + downloads of binary assets).
 *               Phase 1.6 (M8): renamed from /asset/ — the singular form
 *               was a Phase-1 M2 typo that never matched what either the
 *               frontend (worker/sync/large_title.cljs:62) or the
 *               node-adapter (deps/db-sync/.../node/dispatch.cljs:38)
 *               actually uses. See docs/hypha/phase-1.6-cross-device.md V8.
 *
 * Hypha-server does NOT verify JWTs itself for these routes. Auth lives in
 * node-adapter, so a single source of truth governs access control.
 */

import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsync } from "fastify";
import type { IncomingHttpHeaders } from "node:http";

export interface ProxyDeps {
  /** Upstream base URL, e.g. "http://127.0.0.1:8787". */
  upstreamUrl: string;
}

/**
 * Inject X-Forwarded-* headers so downstream services (notably the
 * db-sync node-adapter) can reconstruct the public-facing URL when they
 * embed it in response bodies (e.g. /sync/<id>/snapshot/download returns
 * a JSON `url` field for the follow-up snapshot stream fetch).
 *
 * Without these headers, db-sync would use request.url.origin which
 * equals the internal loopback (http://127.0.0.1:8787 in the Docker
 * image) — unreachable from the browser. See Phase-1.6 V10 click-bug
 * diagnosis in docs/hypha/phase-1.6-cross-device.md.
 *
 * Operator note: when a reverse proxy (Caddy/nginx) terminates TLS in
 * front of hypha-server, IT must set x-forwarded-proto=https and
 * x-forwarded-host=<public host>. We pass those through verbatim if set,
 * else derive sensible defaults from the request the browser sent us.
 */
// `req` is a FastifyRequest but @fastify/reply-from's overload chooses an
// HTTP/1.1-only variant of the FastifyRequest generic. The library passes
// us the same FastifyRequest, just with a narrower type signature. Use a
// minimal structural type to avoid the generic-variance mismatch while
// still getting the two fields we actually need (.headers, .protocol).
type ForwardableRequest = {
  headers: IncomingHttpHeaders;
  protocol?: string;
};

function buildForwardedHeaders(req: ForwardableRequest, base: IncomingHttpHeaders): IncomingHttpHeaders {
  // Read host from the ORIGINAL FastifyRequest, NOT from `base`. By the
  // time @fastify/reply-from calls rewriteRequestHeaders, it has already
  // rewritten the Host header to the upstream's address (e.g.
  // 127.0.0.1:8787 in production). Only req.headers retains the
  // browser-visible host (e.g. localhost:3030).
  const browserHost = (req.headers["x-forwarded-host"] as string) ??
                      (req.headers["host"] as string) ??
                      (base["host"] as string) ??
                      "";
  const browserProto = (req.headers["x-forwarded-proto"] as string) ??
                       req.protocol ??
                       "http";
  return {
    ...base,
    "x-forwarded-host": browserHost,
    "x-forwarded-proto": browserProto,
  };
}

export const proxyRoute: FastifyPluginAsync<ProxyDeps> = async (app, deps) => {
  const sharedReplyOptions = {
    rewriteRequestHeaders: ((req: ForwardableRequest, headers: IncomingHttpHeaders) =>
      buildForwardedHeaders(req, headers)) as never,
  };

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/sync",
    rewritePrefix: "/sync",
    websocket: true,
    replyOptions: sharedReplyOptions,
  });

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/graphs",
    rewritePrefix: "/graphs",
    replyOptions: sharedReplyOptions,
  });

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/e2ee",
    rewritePrefix: "/e2ee",
    replyOptions: sharedReplyOptions,
  });

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/assets",
    rewritePrefix: "/assets",
    replyOptions: sharedReplyOptions,
  });
};
