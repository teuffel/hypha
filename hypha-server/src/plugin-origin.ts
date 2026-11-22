/**
 * Env parsing for the plugin-assets origin. Kept free of side effects so
 * the fail-fast rules are unit-testable.
 */

export function parsePort(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} must be an integer port (0-65535), got "${raw}"`);
  }
  return n;
}

/**
 * Normalise HYPHA_PLUGIN_ORIGIN to a bare origin ("scheme://host[:port]").
 *
 * Fails fast when the value is not an http(s) origin, or when it equals the
 * app's own origin (`appUrl`, i.e. HYPHA_JWT_ISSUER — documented as the URL
 * the browser loads Hypha from). Pointing both at the same origin would
 * silently undo the isolation this listener exists for.
 */
export function parsePluginOrigin(raw: string | undefined, appUrl: string): string | null {
  if (!raw || raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`HYPHA_PLUGIN_ORIGIN is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HYPHA_PLUGIN_ORIGIN must be http(s), got "${raw}"`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `HYPHA_PLUGIN_ORIGIN must be a bare origin without path/query (got "${raw}")`,
    );
  }
  let appOrigin: string | null = null;
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    appOrigin = null;
  }
  if (appOrigin !== null && appOrigin === url.origin) {
    throw new Error(
      `HYPHA_PLUGIN_ORIGIN (${url.origin}) must differ from the app origin ` +
        `(HYPHA_JWT_ISSUER). Plugins must be served from a separate origin.`,
    );
  }
  return url.origin;
}
