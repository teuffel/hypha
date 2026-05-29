/**
 * Headless-auth smoke test.
 *
 * Catches semantic upstream drift the literal HYPHA_MODE grep cannot:
 *   - Hypha login modal actually renders when the app boots without a cookie.
 *   - POST /auth/login returns a well-formed Hypha JWT.
 *   - The init.cljs /auth/session flow places the JWT into state and skips
 *     the login modal on the next page load.
 *
 * Plan reference: docs/hypha/phase-1-plan.md M4 Headless-Auth-Smoke-Test.
 * Targets the 30s runtime budget noted there; on a release-built static/
 * the spec suite finishes in ~10 s on a typical dev machine.
 *
 * Pre-condition: bin/hypha-build --release was run. The Playwright global
 * setup checks for this and fails fast with a clear error.
 */

import { test, expect, type Page } from "@playwright/test";

const ACCESS_CODE = process.env.HYPHA_TEST_ACCESS_CODE ?? "hypha-test";
const HYPHA_LOGIN_FORM = "form.cp__hypha-login";
const LOGIN_INPUT = `${HYPHA_LOGIN_FORM} input[type="password"]`;
const LOGIN_SUBMIT = `${HYPHA_LOGIN_FORM} button[type="submit"]`;

test.describe("Hypha headless auth smoke", () => {
  test("page is cross-origin isolated (sqlite-wasm + OPFS prerequisite)", async ({ page }) => {
    await page.goto("/");
    // sqlite-wasm needs SharedArrayBuffer for OPFS writes. Browsers gate it
    // behind cross-origin isolation, which in turn requires
    // Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy on the
    // page response. Without these, Logseq's graph persistence + imports
    // silently fail with "Cannot write DOMException" inside the worker.
    const isolation = await page.evaluate(() => ({
      crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
      sharedArrayBuffer: typeof (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer,
    }));
    expect(isolation.crossOriginIsolated).toBe(true);
    expect(isolation.sharedArrayBuffer).toBe("function");
  });

  test("POST /auth/login returns a well-formed Hypha JWT", async ({ request }) => {
    const res = await request.post("/auth/login", { data: { code: ACCESS_CODE } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body["id-token"]).toBeTruthy();

    const parts = (body["id-token"] as string).split(".");
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    // sub is the UUID-formatted Hypha user identifier. Critical that this
    // is UUID-shaped: Logseq's worker pipeline runs (uuid sub) to create
    // the created-by user page, whose UUID then has to survive the
    // search-index validator. Non-UUID sub breaks graph persistence.
    expect(payload.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.iss).toBe("http://localhost");
    expect(payload.aud).toBe("hypha-test");
    expect(payload["cognito:username"]).toBe("hypha-user");
    expect(payload["preferred_username"]).toBe("hypha-user");
    expect(payload.email).toBeTruthy();
  });

  test("wrong access code returns 401", async ({ request }) => {
    const res = await request.post("/auth/login", { data: { code: "wrong-code" } });
    expect(res.status()).toBe(401);
  });

  test("fresh browser without cookie shows the Hypha login modal", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(HYPHA_LOGIN_FORM)).toBeVisible({ timeout: 25_000 });
  });

  test("login modal accepts the access code and closes on success", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(HYPHA_LOGIN_FORM)).toBeVisible({ timeout: 25_000 });
    await page.locator(LOGIN_INPUT).fill(ACCESS_CODE);
    await page.locator(LOGIN_SUBMIT).click();
    await expect(page.locator(HYPHA_LOGIN_FORM)).not.toBeVisible({ timeout: 10_000 });
  });

  test("page reload with valid cookie skips the login modal", async ({ browser }) => {
    // First page-load + login: establish the HttpOnly session cookie.
    const ctx = await browser.newContext();
    const first = await ctx.newPage();
    await first.goto("/");
    await expect(first.locator(HYPHA_LOGIN_FORM)).toBeVisible({ timeout: 25_000 });
    await first.locator(LOGIN_INPUT).fill(ACCESS_CODE);
    await first.locator(LOGIN_SUBMIT).click();
    await expect(first.locator(HYPHA_LOGIN_FORM)).not.toBeVisible({ timeout: 10_000 });
    await first.close();

    // Second page-load on the same context: cookie is replayed, /auth/session
    // returns the JWT, hypha-init/start! places it in state, modal stays away.
    const second = await ctx.newPage();
    await second.goto("/");
    // We allow up to 10s for any modal to appear. If it does not appear at
    // all in that window, the session-restoration path worked.
    await expectModalNotToAppear(second, 8_000);
    await second.close();
    await ctx.close();
  });
});

async function expectModalNotToAppear(page: Page, windowMs: number): Promise<void> {
  // Active wait: poll the locator. If it ever becomes visible during the
  // window, the test fails. This is more reliable than `not.toBeVisible`
  // because we want to fail on a TRANSIENT appearance, not just a final
  // not-present state.
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const count = await page.locator(HYPHA_LOGIN_FORM).count();
    if (count > 0) {
      throw new Error(
        "expected no Hypha login modal during session-restore, but one appeared",
      );
    }
    await page.waitForTimeout(250);
  }
}
