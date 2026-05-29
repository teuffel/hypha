/**
 * Cross-device personal-cloud drift gates (Phase 1.6 M10).
 *
 * Verifies the three M9 mechanisms that make Browser-A → Browser-B
 * data flow possible:
 *
 *   M9.1  set-hypha-id-token! fires <get-remote-graphs after every successful
 *         auth — checked here by watching for the GET /graphs request
 *         landing on the network tap.
 *   M9.2  logged-in? returns true in Hypha (id-token-based) — checked
 *         indirectly through the side-effect: the M9.1 auto-fetch is
 *         only useful because logged-in? gates several upload UIs.
 *   M9.3  Default-cloud-on/e2ee-off in new-db-graph-inner — NOT smoke-tested
 *         here (would need a stateful db-sync adapter that doesn't exist
 *         in the current test setup; see docs/hypha/phase-1.6-cross-device.md
 *         §M10 scope-adjustment note). Verified by code-review +
 *         compiled-output spot-check at M9 commit time + V10 manual probe.
 *
 * Cross-device specifics (independent of M9 mechanisms):
 *
 *   T3   Same access code → same JWT sub claim across BrowserContexts.
 *        Catches a hypothetical hypha-server/src/auth/jwt.ts regression
 *        that ever made sub session-random; cross-device would be
 *        instantly impossible.
 *   T4   Different BrowserContexts have isolated cookie jars. Confirms
 *        each device must auth on its own, which IS the cross-device
 *        story (and protects against cookie-domain misconfiguration).
 *
 * Hermetic: reuses the M7 globalSetup; mockSyncUpstream returns 403 on
 * /graphs but that's fine — T1/T2 verify that the call FIRES, not that
 * it succeeds. A future Phase-2 M11 will add a stateful adapter to drive
 * the full Browser-A-creates → Browser-B-downloads roundtrip; that's
 * out of scope for Phase 1.6.
 *
 * Plan reference: docs/hypha/phase-1.6-cross-device.md §4 M10.
 */

import { test, expect, type Page } from "@playwright/test";

const ACCESS_CODE = process.env.HYPHA_TEST_ACCESS_CODE ?? "hypha-test";
const HYPHA_LOGIN_FORM = "form.cp__hypha-login";
const LOGIN_INPUT = `${HYPHA_LOGIN_FORM} input[type="password"]`;
const LOGIN_SUBMIT = `${HYPHA_LOGIN_FORM} button[type="submit"]`;

/** Matches GET /graphs and /graphs?<query> — but NOT /graphs/<id>/<sub>. */
const GRAPHS_LIST_URL = /\/graphs(?:\?|$)/;

async function loginViaModal(page: Page): Promise<void> {
  await expect(page.locator(HYPHA_LOGIN_FORM)).toBeVisible({ timeout: 25_000 });
  await page.locator(LOGIN_INPUT).fill(ACCESS_CODE);
  await page.locator(LOGIN_SUBMIT).click();
  await expect(page.locator(HYPHA_LOGIN_FORM)).not.toBeVisible({ timeout: 10_000 });
}

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`malformed JWT: ${parts.length} parts`);
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
}

test.describe("Hypha cross-device personal-cloud drift gates", () => {
  test("M9.1 — fresh access-code login fires GET /graphs", async ({ page }) => {
    const graphListRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (GRAPHS_LIST_URL.test(url)) graphListRequests.push(url);
    });

    await page.goto("/");
    await loginViaModal(page);

    // Auto-fetch is non-blocking; poll up to 10s. <get-remote-graphs internally
    // awaits task--ensure-id&access-token before issuing the HTTP call, so
    // it's not race-instantaneous with set-hypha-id-token!.
    await expect.poll(() => graphListRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  test("M9.1 — cookie-session restore on reload also fires GET /graphs", async ({ browser }) => {
    // First context: establish the HttpOnly session cookie.
    const ctx = await browser.newContext();
    const seedPage = await ctx.newPage();
    await seedPage.goto("/");
    await loginViaModal(seedPage);
    await seedPage.close();

    // Fresh page in the SAME context: the cookie should restore the
    // session via GET /auth/session, which calls set-hypha-id-token!,
    // which must ALSO trigger <fetch-remote-graphs-after-login!.
    const reloadPage = await ctx.newPage();
    const graphListRequests: string[] = [];
    reloadPage.on("request", (req) => {
      const url = req.url();
      if (GRAPHS_LIST_URL.test(url)) graphListRequests.push(url);
    });
    await reloadPage.goto("/");
    await expect.poll(() => graphListRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await reloadPage.close();
    await ctx.close();
  });

  test("Cross-device identity — two contexts share the same JWT sub", async ({ request }) => {
    // Hit /auth/login twice directly (Playwright's request fixture has its
    // own cookie jar, but each call gets a fresh JWT in the body). The
    // tokens themselves differ (different jti / iat), but `sub` must be
    // stable because hypha-server mints `sub = userUuid` from config —
    // single-user, deterministic.
    const [resA, resB] = await Promise.all([
      request.post("/auth/login", { data: { code: ACCESS_CODE } }),
      request.post("/auth/login", { data: { code: ACCESS_CODE } }),
    ]);
    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    const tokenA = (await resA.json())["id-token"] as string;
    const tokenB = (await resB.json())["id-token"] as string;
    const subA = parseJwtPayload(tokenA).sub as string;
    const subB = parseJwtPayload(tokenB).sub as string;

    expect(subA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(subB).toBe(subA);
  });

  test("M9.4 — no 'worker auth refresh requires refresh token' after login", async ({ page }) => {
    // Phase-1.6 V10 found: M9.1's <get-remote-graphs invokes
    // <ensure-user-rsa-keys-on-server!, which crosses the frontend→worker
    // boundary. Stock Logseq's :rtc/sync-app-state event gates the
    // auth-state push on :git/current-repo, but M9.1 fires BEFORE any
    // graph is loaded → worker has no :auth/id-token → falls into the
    // Cognito refresh path → throws because Hypha has no refresh-token.
    //
    // M9.4 fix (hypha/init.cljs): <push-auth-to-db-worker! runs BEFORE
    // <get-remote-graphs, so the worker always has the JWT when needed.
    // This test is the drift gate — any future change that removes the
    // pre-push will surface the error in the console.
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await page.goto("/");
    await loginViaModal(page);
    // Auto-fetch is async; let it complete (rsa-key path runs INSIDE
    // <get-remote-graphs at sync.cljs:316).
    await page.waitForTimeout(6000);

    const refreshTokenFailures = consoleErrors.filter((m) =>
      m.includes("missing-refresh-token") ||
      m.includes("worker auth refresh requires refresh token"),
    );
    expect(
      refreshTokenFailures,
      `regression: refresh-token errors leaked from worker:\n${refreshTokenFailures.join("\n")}`,
    ).toHaveLength(0);
  });

  test("Cookie isolation — Context A login leaves Context B unauthenticated", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto("/");
    await loginViaModal(pageA);
    await pageA.close();

    // A separate context must NOT carry A's session cookie. Confirms
    // per-browser auth requirement, which is the cross-device story.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto("/");
    // Login modal must appear — proving Context B is unauthenticated even
    // though Context A just authed against the same hypha-server.
    await expect(pageB.locator(HYPHA_LOGIN_FORM)).toBeVisible({ timeout: 25_000 });

    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });
});
