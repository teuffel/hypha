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

export interface ProxyDeps {
  /** Upstream base URL, e.g. "http://127.0.0.1:8787". */
  upstreamUrl: string;
}

export const proxyRoute: FastifyPluginAsync<ProxyDeps> = async (app, deps) => {
  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/sync",
    rewritePrefix: "/sync",
    websocket: true,
  });

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/graphs",
    rewritePrefix: "/graphs",
  });

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/e2ee",
    rewritePrefix: "/e2ee",
  });

  await app.register(fastifyHttpProxy, {
    upstream: deps.upstreamUrl,
    prefix: "/assets",
    rewritePrefix: "/assets",
  });
};
