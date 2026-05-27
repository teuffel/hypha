/**
 * /plugin-market/* — caching reverse-proxy for the Logseq marketplace JSON
 * + package assets served from raw.githubusercontent.com/logseq/marketplace.
 *
 *   GET /plugin-market/plugins.json     → upstream /plugins.json   (TTL 1h)
 *   GET /plugin-market/stats.json       → upstream /stats.json     (TTL 1h)
 *   GET /plugin-market/packages/<sub>   → upstream /packages/<sub> (TTL 24h)
 *
 * The hypha frontend reaches these routes via `window.fetch` interception
 * (see src/main/frontend/hypha/plugin_init.cljs) — the Logseq UI still
 * believes it is hitting GitHub.
 *
 * The 1h TTL on the index JSONs matches the practical refresh cadence of
 * the marketplace; package assets are versioned indirectly via R2 manifests
 * fetched through /plugin-cdn/r2/*, so 24h is safe.
 */

import type { FastifyPluginAsync } from "fastify";
import { PluginCache, isSafeSubpath, serveCached } from "../plugin-cache.js";

const INDEX_TTL_SECONDS = 3600;
const PACKAGE_TTL_SECONDS = 86_400;

export interface PluginMarketDeps {
  cache: PluginCache;
  /** e.g. "https://raw.githubusercontent.com/logseq/marketplace/master" (no trailing slash). */
  upstreamBase: string;
}

export const pluginMarketRoute: FastifyPluginAsync<PluginMarketDeps> = async (app, deps) => {
  app.get("/plugin-market/plugins.json", async (_request, reply) =>
    serveCached({
      cache: deps.cache,
      cacheKey: "market:plugins.json",
      upstreamUrl: `${deps.upstreamBase}/plugins.json`,
      ttlSeconds: INDEX_TTL_SECONDS,
      reply,
    }),
  );

  app.get("/plugin-market/stats.json", async (_request, reply) =>
    serveCached({
      cache: deps.cache,
      cacheKey: "market:stats.json",
      upstreamUrl: `${deps.upstreamBase}/stats.json`,
      ttlSeconds: INDEX_TTL_SECONDS,
      reply,
    }),
  );

  app.get("/plugin-market/packages/*", async (request, reply) => {
    const subpath = (request.params as { "*": string })["*"];
    if (!isSafeSubpath(subpath)) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    return serveCached({
      cache: deps.cache,
      cacheKey: `market:packages:${subpath}`,
      upstreamUrl: `${deps.upstreamBase}/packages/${subpath}`,
      ttlSeconds: PACKAGE_TTL_SECONDS,
      reply,
    });
  });
};
