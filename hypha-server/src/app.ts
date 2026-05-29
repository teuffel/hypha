/**
 * Fastify app factory.
 *
 * Split out from main.ts so the test suite can build an instance and use
 * Fastify's `inject()` API without binding a TCP port.
 *
 * The factory wires:
 *   - cookie parsing (hypha-session HttpOnly cookie)
 *   - /auth/login, /auth/session, /auth/logout, /auth/jwks
 *   - /health
 *   - / (statics root)
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";

import type { HyphaRuntime } from "./config.js";
import { SessionStore } from "./auth/session.js";
import { loginRoute } from "./routes/login.js";
import { sessionRoute } from "./routes/session.js";
import { logoutRoute } from "./routes/logout.js";
import { jwksRoute } from "./routes/jwks.js";
import { proxyRoute } from "./proxy.js";
import { staticsRoute } from "./statics.js";
import { PluginCache } from "./plugin-cache.js";
import { pluginMarketRoute } from "./routes/plugin-market.js";
import { pluginCdnRoute } from "./routes/plugin-cdn.js";

/** Default capacity for the plugin-marketplace+CDN cache (Phase 1.5). */
const DEFAULT_PLUGIN_CACHE_MAX_ENTRIES = 256;

export interface BuildAppOptions {
  config: HyphaRuntime;
  /**
   * Optional static directory root. When unset, statics serving is skipped —
   * useful for tests that only exercise the auth API surface.
   */
  staticDir?: string;
  /**
   * Optional db-sync upstream URL. When unset the /sync and /asset proxy
   * routes are skipped — tests that exercise only the auth surface leave
   * this out.
   */
  syncUpstreamUrl?: string;
  /**
   * Optional plugin marketplace + R2 CDN upstream bases. When unset the
   * /plugin-market/* and /plugin-cdn/* routes are skipped — tests that
   * don't exercise the plugin surface leave this out.
   */
  pluginUpstream?: {
    /** e.g. "https://raw.githubusercontent.com/logseq/marketplace/master". */
    marketBase: string;
    /** e.g. "https://plugins.logseq.io/r2". */
    cdnBase: string;
    /**
     * e.g. "https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev". Public
     * R2 bucket where plugin iframe assets live. Phase 1.6.2 proxies
     * these so COEP=credentialless passes; see
     * docs/hypha/phase-1.6.2-plugin-iframe-corp.md.
     */
    assetsBase: string;
    /** Override default cache capacity (entries). */
    cacheMaxEntries?: number;
  };
  logLevel?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logLevel === "silent" ? false : { level: opts.logLevel ?? "info" },
  });

  // Cross-origin isolation — required for Logseq's sqlite-wasm in the
  // browser. Without these headers, SharedArrayBuffer is undefined and
  // OPFS writes fail with "Cannot write DOMException", which breaks
  // graph persistence + imports.
  //
  // COEP=credentialless instead of require-corp keeps cross-origin
  // resources loadable without their servers needing to advertise CORP —
  // matters for Logseq's external icon CDNs, image proxies, etc. The
  // page itself is still cross-origin isolated; SharedArrayBuffer works.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Embedder-Policy", "credentialless");
  });

  await app.register(fastifyCookie);

  const sessions = new SessionStore(opts.config.sessionTtlSeconds);

  const pluginCache = opts.pluginUpstream
    ? new PluginCache(opts.pluginUpstream.cacheMaxEntries ?? DEFAULT_PLUGIN_CACHE_MAX_ENTRIES)
    : null;

  // /health is plain-text "ok" by default. ?detail=cache surfaces the
  // plugin-cache stats so V4 (cache-hit-rate ≥ 80% after a few F5s) can be
  // verified by a curl probe from the deployed container.
  app.get("/health", async (request) => {
    const detail = (request.query as { detail?: string } | undefined)?.detail;
    if (detail === "cache" && pluginCache) {
      return { status: "ok", cache: pluginCache.getStats() };
    }
    return { status: "ok" };
  });

  await app.register(loginRoute, { config: opts.config, sessions });
  await app.register(sessionRoute, { config: opts.config, sessions });
  await app.register(logoutRoute, { sessions });
  await app.register(jwksRoute, { config: opts.config });

  if (opts.syncUpstreamUrl) {
    await app.register(proxyRoute, { upstreamUrl: opts.syncUpstreamUrl });
  }

  if (opts.pluginUpstream && pluginCache) {
    await app.register(pluginMarketRoute, {
      cache: pluginCache,
      upstreamBase: opts.pluginUpstream.marketBase,
    });
    await app.register(pluginCdnRoute, {
      cache: pluginCache,
      upstreamBase: opts.pluginUpstream.cdnBase,
      assetsUpstreamBase: opts.pluginUpstream.assetsBase,
    });
  }

  if (opts.staticDir) {
    await app.register(staticsRoute, { staticDir: opts.staticDir });
  }

  return app;
}
