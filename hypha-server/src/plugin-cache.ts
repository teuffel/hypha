/**
 * In-memory LRU+TTL cache + shared "serve cached upstream" helper for the
 * plugin-marketplace and plugin-CDN reverse proxies.
 *
 * Phase 1.5 ships memory-only caching: a container restart drops the cache,
 * which is acceptable because the first browse after restart just re-fetches
 * upstream. Persistent disk caching is Phase-2 material (air-gapped setups).
 *
 * Eviction policy:
 *   - Per-entry TTL: callers pick a TTL when they `set(...)`.
 *   - Capacity-bound: oldest entry by insertion/access order is evicted when
 *     `size > maxEntries`. `get(...)` promotes a hit to "most-recently-used"
 *     by deleting + re-inserting (Map preserves insertion order).
 *
 * Stats (hits/misses/evictions) are exposed for V4 verification (cache-hit
 * rate ≥ 80% after a few browser reloads) via `GET /health?detail=cache`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { SessionStore, SESSION_COOKIE_NAME } from "./auth/session.js";

/**
 * preHandler for the plugin proxies on the APP origin (/plugin-market/*,
 * /plugin-cdn/r2/*): only a logged-in browser may use them.
 *
 * Requiring the session cookie stops anonymous use and drive-by navigations
 * from other sites: the cookie is SameSite=Strict, so a cross-site
 * navigation does not carry it, while the app's own fetches do.
 *
 * Deliberately NOT used by the plugin-assets listener (plugin-app.ts): that
 * runs on a separate origin, which on its own hostname never receives the
 * session cookie, and whose whole point is that nothing session-related
 * lives there.
 */
export function requireSession(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId || !sessions.lookup(sessionId)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

export interface CacheEntry {
  body: Buffer;
  contentType: string;
  /** epoch-ms; entry is stale at or after this instant. */
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
}

export class PluginCache {
  private readonly store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxEntries: number) {
    if (maxEntries <= 0) {
      throw new Error(`PluginCache maxEntries must be > 0 (got ${maxEntries})`);
    }
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // LRU touch: re-insert so this key is now the most-recent in Map order.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, entry);
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
      this.evictions++;
    }
  }

  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.store.size,
      maxSize: this.maxEntries,
    };
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Reject wildcard subpaths that try to escape the upstream prefix or smuggle
 * absolute URLs. This is the cheap textual check; `resolveUpstreamUrl` is the
 * one that decides.
 *
 * A "%" is rejected outright. The router has already percent-decoded the
 * path once, so one that is still there came in double-encoded
 * (`%252e%252e` arrives here as `%2e%2e`), and `fetch()`'s URL parser treats
 * `%2e%2e` exactly like `..`. "?" and "#" can only come from an encoded
 * `%3F`/`%23` for the same reason; they would turn part of the path into a
 * query or fragment upstream.
 */
export function isSafeSubpath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/[%?#]/.test(p)) return false;
  // Reject any path containing a ".." segment.
  for (const segment of p.split(/[/\\]/)) {
    if (segment === "..") return false;
  }
  return true;
}

/**
 * Build the upstream URL for `subpath` below `base` (no trailing slash), or
 * null when the request must be refused.
 *
 * The URL is parsed the way `fetch()` will parse it and has to stay below
 * `base` afterwards. Checking the string alone is not enough: the parser
 * resolves dot segments in every spelling it knows, and both upstreams host
 * other people's content next to ours (any repository on
 * raw.githubusercontent.com, any plugin in the bucket). A request that
 * climbs out of the prefix would be served from the Hypha origin.
 *
 * The returned URL is the normalised one, so it is also the right cache key.
 */
export function resolveUpstreamUrl(base: string, subpath: string): string | null {
  if (!isSafeSubpath(subpath)) return null;
  let baseUrl: URL;
  let url: URL;
  try {
    baseUrl = new URL(`${base}/`);
    url = new URL(`${base}/${subpath}`);
  } catch {
    return null;
  }
  if (url.origin !== baseUrl.origin) return null;
  if (!url.pathname.startsWith(baseUrl.pathname)) return null;
  return url.href;
}

/**
 * Headers for third-party content that is proxied through the MAIN app
 * origin (/plugin-market/*, /plugin-cdn/r2/*). These routes are consumed via
 * `fetch()` only, so the bytes must never be interpreted as an active
 * document on the app origin if someone navigates to the URL directly:
 *   - nosniff: no content-type guessing.
 *   - CSP sandbox: if the upstream ever answers with text/html or SVG, the
 *     browser renders it in an opaque origin with scripts disabled. CSP on
 *     a fetch()/img response is ignored, so regular consumers are unaffected.
 */
export const INERT_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
};

export interface ServeCachedOptions {
  cache: PluginCache;
  cacheKey: string;
  upstreamUrl: string;
  ttlSeconds: number;
  reply: FastifyReply;
  /**
   * Extra response headers applied to every reply (HIT, MISS, BYPASS).
   * Used by the plugin-asset route to inject
   * `cross-origin-resource-policy: cross-origin` so iframe loads pass
   * Hypha's required COEP=credentialless gate. See
   * docs/hypha/phase-1.6.2-plugin-iframe-corp.md.
   */
  extraHeaders?: Record<string, string>;
}

function applyExtraHeaders(
  reply: FastifyReply,
  extraHeaders: Record<string, string> | undefined,
): void {
  if (!extraHeaders) return;
  for (const [name, value] of Object.entries(extraHeaders)) {
    reply.header(name, value);
  }
}

/**
 * Minimal MIME-type sniffer for upstreams that respond without a
 * Content-Type header (the Cloudflare R2 public bucket where Logseq
 * hosts plugin iframe assets does this for every file). Sniffing from
 * the URL's path extension is the same heuristic browsers apply by
 * default, but we have to do it server-side because we re-emit the
 * response under our own origin.
 *
 * Without this, the iframe load defaults to application/octet-stream,
 * which browsers treat as a download rather than rendering as HTML —
 * the iframe stays blank, plugin code never runs, and the handshake
 * timeout fires anyway.
 */
function sniffContentTypeFromUrl(url: string): string | undefined {
  // Strip query + fragment, take basename extension.
  const pathnameOnly = url.split("?")[0].split("#")[0];
  const dot = pathnameOnly.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = pathnameOnly.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    case "map":
      return "application/json; charset=utf-8";
    default:
      return undefined;
  }
}

/**
 * Serve a cached upstream response, refreshing on miss.
 *
 *   - Cache HIT  →  200 + cached body + `X-Hypha-Cache: HIT`
 *   - Cache MISS →  fetch upstream:
 *       2xx  →  cache + 200 + body + `X-Hypha-Cache: MISS`
 *       other → propagate upstream status (NOT cached; transient 5xx and
 *               legitimate 404s shouldn't pollute the cache)
 *   - Network failure → 502 `{ error: "upstream_unreachable" }`
 *
 * Body is captured as a Buffer so binary plugin assets (icons, .js bundles)
 * round-trip identically.
 */
export async function serveCached(opts: ServeCachedOptions): Promise<FastifyReply> {
  const hit = opts.cache.get(opts.cacheKey);
  if (hit) {
    applyExtraHeaders(opts.reply, opts.extraHeaders);
    opts.reply.header("X-Hypha-Cache", "HIT");
    opts.reply.header("Content-Type", hit.contentType);
    return opts.reply.code(200).send(hit.body);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(opts.upstreamUrl);
  } catch {
    return opts.reply.code(502).send({ error: "upstream_unreachable" });
  }

  // Order of precedence:
  //   1. Upstream Content-Type if present.
  //   2. Extension-sniffed type from the upstream URL.
  //   3. application/octet-stream (truly unknown — let the client interpret).
  const upstreamContentType = upstreamRes.headers.get("content-type");
  const contentType =
    upstreamContentType ??
    sniffContentTypeFromUrl(opts.upstreamUrl) ??
    "application/octet-stream";
  const body = Buffer.from(await upstreamRes.arrayBuffer());

  if (!upstreamRes.ok) {
    applyExtraHeaders(opts.reply, opts.extraHeaders);
    opts.reply.header("X-Hypha-Cache", "BYPASS");
    opts.reply.header("Content-Type", contentType);
    return opts.reply.code(upstreamRes.status).send(body);
  }

  opts.cache.set(opts.cacheKey, {
    body,
    contentType,
    expiresAt: Date.now() + opts.ttlSeconds * 1000,
  });

  applyExtraHeaders(opts.reply, opts.extraHeaders);
  opts.reply.header("X-Hypha-Cache", "MISS");
  opts.reply.header("Content-Type", contentType);
  return opts.reply.code(200).send(body);
}
