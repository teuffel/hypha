/**
 * Plugin-assets listener — a SECOND Fastify instance on its own port, and
 * therefore its own browser origin.
 *
 * Why a separate origin: web-plugin iframes load third-party HTML/JS from
 * the Logseq marketplace bucket. Phase 1.6.2 proxied those files through
 * the main hypha-server origin (to add the CORP header the bucket lacks),
 * which made every plugin document same-origin with the app: plugin code
 * could call GET /auth/session with the session cookie, read the JWT and
 * reach into the parent window. Even an uninstalled plugin file became a
 * stored-XSS vector via a crafted link to /plugin-cdn/assets/<path>.
 *
 * Serving the same proxy from a different origin restores upstream
 * Logseq's isolation model (plugin iframe is cross-origin, talks to the
 * host via postMessage only) while keeping the CORP/COEP header fix.
 *
 * This instance deliberately knows NOTHING about auth, sessions, sync or
 * statics, and does not require a session: on its own hostname the browser
 * never sends it the session cookie, and the content is public marketplace
 * data. Do not register additional routes here.
 */

import Fastify, { type FastifyInstance } from "fastify";

import { PluginCache, resolveUpstreamUrl, serveCached } from "./plugin-cache.js";

const ASSETS_TTL_SECONDS = 86_400;
const DEFAULT_CACHE_MAX_ENTRIES = 256;

export interface BuildPluginAssetsAppOptions {
  /** e.g. "https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev". */
  assetsBase: string;
  cacheMaxEntries?: number;
  logLevel?: string;
}

export async function buildPluginAssetsApp(
  opts: BuildPluginAssetsAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logLevel === "silent" ? false : { level: opts.logLevel ?? "info" },
  });

  const cache = new PluginCache(opts.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);

  // Set on EVERY reply (hits, misses, upstream errors, 400/404):
  //   - CORP cross-origin + COEP credentialless: the embedding app page is
  //     cross-origin isolated (COEP=credentialless); a cross-origin iframe
  //     document is only allowed in when it carries both.
  //   - nosniff: the content type we emit is authoritative.
  //   - ACAO *: content is public and this origin never sees credentials,
  //     so letting the app `fetch()` plugin files is harmless.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cross-Origin-Embedder-Policy", "credentialless");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Access-Control-Allow-Origin", "*");
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/plugin-cdn/assets/*", async (request, reply) => {
    const subpath = (request.params as { "*": string })["*"];
    // Same guard as the app-origin proxies: parse like fetch() will and
    // stay below the bucket base; the normalised URL is the cache key.
    const upstreamUrl = resolveUpstreamUrl(opts.assetsBase, subpath);
    if (!upstreamUrl) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    return serveCached({
      cache,
      cacheKey: `cdn:assets:${upstreamUrl}`,
      upstreamUrl,
      ttlSeconds: ASSETS_TTL_SECONDS,
      reply,
    });
  });

  return app;
}
