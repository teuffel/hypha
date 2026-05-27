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

import type { FastifyReply } from "fastify";

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
 * absolute URLs. GitHub raw and Cloudflare R2 both normalize `..` server-side,
 * but our cache keys would diverge from the canonical path, so reject early.
 */
export function isSafeSubpath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // Reject any path containing a ".." segment.
  for (const segment of p.split(/[/\\]/)) {
    if (segment === "..") return false;
  }
  return true;
}

export interface ServeCachedOptions {
  cache: PluginCache;
  cacheKey: string;
  upstreamUrl: string;
  ttlSeconds: number;
  reply: FastifyReply;
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

  const contentType = upstreamRes.headers.get("content-type") ?? "application/octet-stream";
  const body = Buffer.from(await upstreamRes.arrayBuffer());

  if (!upstreamRes.ok) {
    opts.reply.header("X-Hypha-Cache", "BYPASS");
    opts.reply.header("Content-Type", contentType);
    return opts.reply.code(upstreamRes.status).send(body);
  }

  opts.cache.set(opts.cacheKey, {
    body,
    contentType,
    expiresAt: Date.now() + opts.ttlSeconds * 1000,
  });

  opts.reply.header("X-Hypha-Cache", "MISS");
  opts.reply.header("Content-Type", contentType);
  return opts.reply.code(200).send(body);
}
