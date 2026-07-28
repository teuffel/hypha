/**
 * Capture client — shared by the Firefox and Thunderbird clippers.
 *
 * Auth mirrors the web app: POST the access code to /auth/login, keep the
 * returned JWT in memory, send it as `Authorization: Bearer`. The session
 * cookie is no use here — it is SameSite=Strict and an extension request
 * would not carry it.
 *
 * Hypha regenerates its JWT signing keys on every container start, so a
 * restart invalidates outstanding tokens. A 401 therefore means "log in
 * again", not "something is broken" — hence exactly one silent retry.
 */

function normalizeHost(host) {
  return typeof host === "string" ? host.trim().replace(/\/+$/, "") : "";
}

const JSON_HEADERS = { "content-type": "application/json" };

export function createCaptureClient({ getSettings, fetchImpl = globalThis.fetch }) {
  let token = null;

  async function settings() {
    const { host, accessCode } = await getSettings();
    const normalized = normalizeHost(host);
    if (!normalized || !accessCode) {
      throw new Error("Hypha is not configured — set the server URL and access code in the add-on options.");
    }
    return { host: normalized, accessCode };
  }

  async function login() {
    const { host, accessCode } = await settings();
    const res = await fetchImpl(`${host}/auth/login`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ code: accessCode }),
    });
    if (!res.ok) {
      throw new Error("Hypha rejected the access code — check the add-on options.");
    }
    token = (await res.json())["id-token"];
    return token;
  }

  async function postClip(clip) {
    const { host } = await settings();
    return fetchImpl(`${host}/capture`, {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify(clip),
    });
  }

  /**
   * Send one clip to the inbox. Resolves `{ id }`; throws with a message
   * fit for a notification.
   */
  async function capture(clip) {
    if (!token) await login();

    let res = await postClip(clip);
    if (res.status === 401) {
      await login();
      res = await postClip(clip);
    }
    if (!res.ok) {
      throw new Error(`Hypha refused the clip (HTTP ${res.status}).`);
    }
    return res.json();
  }

  return { capture };
}
