/**
 * Add-on settings, shared by both clippers.
 *
 * The access code is the instance's only credential, so it stays in
 * `storage.local` (never synced to a Mozilla account).
 */

export async function getSettings() {
  const { host = "", accessCode = "" } = await browser.storage.local.get(["host", "accessCode"]);
  return { host, accessCode };
}

export async function saveSettings({ host, accessCode }) {
  await browser.storage.local.set({ host, accessCode });
}
