/**
 * /plugin-cdn/r2/* — caching reverse-proxy for plugins.logseq.io/r2.
 *
 *   GET /plugin-cdn/r2/<repo>/<version>  → R2 manifest JSON
 *
 * Cached for 24h. The r2 upstream is a GitHub-API wrapper (V1 probe
 * 2026-05-27 confirmed 502 with "GitHub API request failed (404)" for
 * missing repos and 2/3 cold probes timing out) so server-side caching
 * shields us from upstream rate-limits + flakiness.
 *
 * NOTE: /plugin-cdn/assets/* (the plugin iframe HTML/JS proxy) is NOT
 * served from this origin. Third-party plugin documents must never be
 * same-origin with the app; they live on the separate plugin-assets
 * listener in ../plugin-app.ts. Do not re-add that route here.
 */

import type { FastifyPluginAsync } from "fastify";
import {
  INERT_RESPONSE_HEADERS,
  PluginCache,
  requireSession,
  resolveUpstreamUrl,
  serveCached,
} from "../plugin-cache.js";
import type { SessionStore } from "../auth/session.js";

const R2_TTL_SECONDS = 86_400;

export interface PluginCdnDeps {
  cache: PluginCache;
  sessions: SessionStore;
  /** e.g. "https://plugins.logseq.io/r2" (no trailing slash). */
  upstreamBase: string;
}

export const pluginCdnRoute: FastifyPluginAsync<PluginCdnDeps> = async (app, deps) => {
  app.addHook("preHandler", requireSession(deps.sessions));

  app.get("/plugin-cdn/r2/*", async (request, reply) => {
    const subpath = (request.params as { "*": string })["*"];
    const upstreamUrl = resolveUpstreamUrl(deps.upstreamBase, subpath);
    if (!upstreamUrl) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    return serveCached({
      cache: deps.cache,
      cacheKey: `cdn:r2:${upstreamUrl}`,
      upstreamUrl,
      ttlSeconds: R2_TTL_SECONDS,
      reply,
      extraHeaders: INERT_RESPONSE_HEADERS,
    });
  });
};
