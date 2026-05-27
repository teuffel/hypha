/**
 * Plugin-marketplace smoke + drift-detection.
 *
 * Verifies the M6 client-side wiring (window.fetch interceptor + window.apis
 * shim, installed by frontend.hypha.plugin-init's defonce) AND the M5
 * server-side proxy (caching reverse-proxy + /health?detail=cache stats).
 *
 * Hermetic: globalSetup spawns an in-process fixture that stands in for
 * raw.githubusercontent.com/logseq/marketplace + plugins.logseq.io/r2, and
 * points hypha-server's plugin proxy upstreams at it via
 * HYPHA_PLUGIN_MARKET_UPSTREAM / HYPHA_PLUGIN_CDN_UPSTREAM. No outbound
 * network — CI flakiness from GitHub rate limits or Cloudflare hiccups
 * can't reach us here. Upstream format drift is the upstream-sync.yml
 * watchdog's responsibility, not this suite's.
 *
 * Plan reference: docs/hypha/phase-1.5-plugin-marketplace.md M7 + section 9.
 */

import { test, expect } from "@playwright/test";

const MARKETPLACE_UPSTREAM_HOST = "raw.githubusercontent.com";
const R2_UPSTREAM_HOST = "plugins.logseq.io";

test.describe("Hypha plugin-marketplace smoke", () => {
  test("plugin-init defonce fires on page load — window.fetch is wrapped", async ({ page }) => {
    await page.goto("/");
    const wrapped = await page.evaluate(() =>
      Boolean((window.fetch as unknown as { __hyphaWrapped?: boolean }).__hyphaWrapped),
    );
    expect(wrapped).toBe(true);
  });

  test("window.apis shim exposes the Hypha-stubbed method surface", async ({ page }) => {
    await page.goto("/");
    const apis = await page.evaluate(() => {
      const w = (window as unknown as { apis?: Record<string, unknown> }).apis;
      if (!w) return null;
      const types: Record<string, string> = {};
      for (const k of [
        "openExternal",
        "openPath",
        "showItemInFolder",
        "relaunch",
        "checkForUpdate",
        "checkForUpdates",
        "setUpdatesCallback",
        "setZoomLevel",
        "toggleMaxOrMinActiveWindow",
        "httpFetchJSON",
        "writeFileBytes",
        "exportPublishAssets",
        // EventEmitter3 surface preserved for plugin IPC.
        "on",
        "off",
        "emit",
        "addListener",
        "removeListener",
      ]) {
        types[k] = typeof (w as Record<string, unknown>)[k];
      }
      return types;
    });
    expect(apis).not.toBeNull();
    // Every method we installed should be a function. Upstream's bare
    // EventEmitter3 shim would NOT have openExternal/openPath/... — so if
    // those are missing, the M6 install order regressed.
    for (const [name, t] of Object.entries(apis!)) {
      expect.soft(t, `window.apis.${name} should be a function`).toBe("function");
    }
  });

  test("interceptor rewrites marketplace + R2 URLs; no request escapes to upstream domains", async ({
    page,
  }) => {
    const observed: string[] = [];
    page.on("request", (req) => observed.push(req.url()));

    await page.goto("/");

    // From the page, ask the (patched) fetch for both upstream URLs. The
    // interceptor must rewrite them to the same-origin Hypha proxy paths
    // BEFORE the browser issues the network request.
    const results = await page.evaluate(async () => {
      const marketRes = await fetch(
        "https://raw.githubusercontent.com/logseq/marketplace/master/plugins.json",
      );
      const cdnRes = await fetch(
        "https://plugins.logseq.io/r2/test-org/test-plugin",
      );
      return {
        marketStatus: marketRes.status,
        marketUrl: marketRes.url,
        cdnStatus: cdnRes.status,
        cdnUrl: cdnRes.url,
      };
    });

    // Both fetches succeed (fixture-served).
    expect(results.marketStatus).toBe(200);
    expect(results.cdnStatus).toBe(200);
    // Response URLs are same-origin Hypha paths.
    expect(results.marketUrl).toContain("/plugin-market/plugins.json");
    expect(results.cdnUrl).toContain("/plugin-cdn/r2/test-org/test-plugin");

    // Drift gate: ZERO requests escape to the real upstream hosts. If
    // upstream Logseq ever ships a code path that bypasses window.fetch
    // (e.g. moves to XHR or shadows the global), this assertion catches
    // it. Without this guard, a regression would silently leak outbound
    // GitHub/Cloudflare traffic from every Hypha install.
    const escapedToMarket = observed.filter((u) => u.includes(MARKETPLACE_UPSTREAM_HOST));
    const escapedToCdn = observed.filter((u) => u.includes(R2_UPSTREAM_HOST));
    expect(escapedToMarket, `unexpected upstream marketplace requests: ${escapedToMarket.join(", ")}`).toHaveLength(0);
    expect(escapedToCdn, `unexpected upstream CDN requests: ${escapedToCdn.join(", ")}`).toHaveLength(0);
  });

  test("/plugin-market/plugins.json proxies the fixture and reports MISS then HIT", async ({ request }) => {
    // Cache may already be warm from earlier tests in this run — request a
    // distinct path that no prior test touched so MISS/HIT ordering is
    // deterministic.
    const first = await request.get("/plugin-market/packages/hypha-smoke/icon.png");
    expect(first.status()).toBe(200);
    expect(first.headers()["x-hypha-cache"]).toBe("MISS");
    expect(first.headers()["content-type"]).toContain("image/png");
    const bodyBytes = await first.body();
    // PNG magic header from the fixture (89 50 4E 47 0D 0A 1A 0A).
    expect(bodyBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const second = await request.get("/plugin-market/packages/hypha-smoke/icon.png");
    expect(second.status()).toBe(200);
    expect(second.headers()["x-hypha-cache"]).toBe("HIT");
  });

  test("/plugin-cdn/r2 proxies fixture R2 manifest", async ({ request }) => {
    const res = await request.get("/plugin-cdn/r2/test-org/test-plugin-hypha-marketplace");
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Fixture-served R2 manifest shape (see global-setup fixtureR2Manifest).
    expect(body.main).toBe("dist/index.html");
    expect(body.name).toBe("test-plugin-hypha-marketplace");
  });

  test("/health?detail=cache reflects cumulative cache activity", async ({ request }) => {
    const res = await request.get("/health?detail=cache");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      cache?: { hits: number; misses: number; size: number; maxSize: number; evictions: number };
    };
    expect(body.status).toBe("ok");
    expect(body.cache).toBeTruthy();
    // Prior tests in this file drove at least 1 hit + several misses.
    expect(body.cache!.hits).toBeGreaterThanOrEqual(1);
    expect(body.cache!.misses).toBeGreaterThanOrEqual(1);
    expect(body.cache!.size).toBeGreaterThanOrEqual(1);
    expect(body.cache!.maxSize).toBeGreaterThan(0);
  });
});
