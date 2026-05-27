/**
 * Reverse-proxy for db-sync traffic.
 *
 * Browser ↔ hypha-server ↔ node-adapter (loopback :8787 by default).
 *
 *   /sync/*  — both HTTP and WebSocket; the browser sends WS upgrades with
 *              a `?token=<JWT>` query parameter, HTTP requests with an
 *              `Authorization: Bearer <JWT>` header. Both are forwarded
 *              verbatim and verified by node-adapter against the JWKS
 *              served at hypha-server's own /auth/jwks endpoint.
 *
 *   /asset/* — HTTP only (uploads + downloads of binary assets).
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
    prefix: "/asset",
    rewritePrefix: "/asset",
  });
};
