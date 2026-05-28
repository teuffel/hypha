/**
 * /plugin-cdn/r2/*     — caching reverse-proxy for plugins.logseq.io/r2.
 * /plugin-cdn/assets/* — caching reverse-proxy for the Cloudflare R2 public
 *                       bucket that hosts the actual plugin iframe assets
 *                       (HTML, JS, CSS bundles referenced by the manifest's
 *                       `main` field).
 *
 *   GET /plugin-cdn/r2/<repo>/<version>             → R2 manifest JSON
 *   GET /plugin-cdn/assets/<repo>/<version>/<path>  → plugin asset
 *
 * Both subpaths cache for 24h. The r2 upstream is a GitHub-API wrapper (V1
 * probe 2026-05-27 confirmed 502 with "GitHub API request failed (404)"
 * for missing repos and 2/3 cold probes timing out) so server-side caching
 * shields us from upstream rate-limits + flakiness.
 *
 * The assets upstream (pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev) hosts
 * a static iframe-html + bundle per plugin version. It responds 200 OK
 * but WITHOUT cross-origin-resource-policy and WITHOUT
 * access-control-allow-origin. Under Hypha's required
 * cross-origin-embedder-policy: credentialless (needed for the OPFS SAH-Pool
 * → Datascript-SQLite path), cross-origin iframes without one of those
 * headers are blocked, breaking every installed plugin with a recurring
 * `handshake Timeout` from libs/src/LSPlugin.caller.ts:296-303.
 *
 * This proxy injects `cross-origin-resource-policy: cross-origin` on every
 * /plugin-cdn/assets/* response so the iframe load passes COEP. See
 * docs/hypha/phase-1.6.2-plugin-iframe-corp.md for the diagnosis trail.
 */

import type { FastifyPluginAsync } from "fastify";
import { PluginCache, isSafeSubpath, serveCached } from "../plugin-cache.js";

const R2_TTL_SECONDS = 86_400;
const ASSETS_TTL_SECONDS = 86_400;

/**
 * Headers injected on every /plugin-cdn/assets/* response. CORP=cross-origin
 * is the minimal opt-in that satisfies COEP=credentialless. The asset is
 * cacheable, but the COEP gate is the structural requirement.
 */
const ASSETS_RESPONSE_HEADERS = {
  "cross-origin-resource-policy": "cross-origin",
} as const;

export interface PluginCdnDeps {
  cache: PluginCache;
  /** e.g. "https://plugins.logseq.io/r2" (no trailing slash). */
  upstreamBase: string;
  /**
   * e.g. "https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev"
   * (no trailing slash). The Cloudflare R2 public bucket that hosts
   * plugin iframe assets.
   */
  assetsUpstreamBase: string;
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

  app.get("/plugin-cdn/assets/*", async (request, reply) => {
    const subpath = (request.params as { "*": string })["*"];
    if (!isSafeSubpath(subpath)) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    return serveCached({
      cache: deps.cache,
      cacheKey: `cdn:assets:${subpath}`,
      upstreamUrl: `${deps.assetsUpstreamBase}/${subpath}`,
      ttlSeconds: ASSETS_TTL_SECONDS,
      reply,
      extraHeaders: ASSETS_RESPONSE_HEADERS,
    });
  });
};
