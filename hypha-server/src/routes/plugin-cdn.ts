/**
 * /plugin-cdn/r2/* — caching reverse-proxy for plugins.logseq.io/r2.
 *
 *   GET /plugin-cdn/r2/<repo>/<version>           → R2 manifest JSON
 *   GET /plugin-cdn/r2/<repo>/<version>/<asset>   → binary plugin asset
 *
 * Both subpaths cache for 24h. The upstream is a GitHub-API wrapper (V1
 * probe 2026-05-27 confirmed 502 with "GitHub API request failed (404)"
 * for missing repos and 2/3 cold probes timing out) so server-side caching
 * shields us from upstream rate-limits + flakiness.
 */

import type { FastifyPluginAsync } from "fastify";
import { PluginCache, isSafeSubpath, serveCached } from "../plugin-cache.js";

const R2_TTL_SECONDS = 86_400;

export interface PluginCdnDeps {
  cache: PluginCache;
  /** e.g. "https://plugins.logseq.io/r2" (no trailing slash). */
  upstreamBase: string;
}

export const pluginCdnRoute: FastifyPluginAsync<PluginCdnDeps> = async (app, deps) => {
  app.get("/plugin-cdn/r2/*", async (request, reply) => {
    const subpath = (request.params as { "*": string })["*"];
    if (!isSafeSubpath(subpath)) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    return serveCached({
      cache: deps.cache,
      cacheKey: `cdn:r2:${subpath}`,
      upstreamUrl: `${deps.upstreamBase}/${subpath}`,
      ttlSeconds: R2_TTL_SECONDS,
      reply,
    });
  });
};
