/**
 * Firefox clipper.
 *
 * Three ways to clip, all ending in the same POST:
 *   - toolbar button
 *   - context menu (page or selection)
 *   - Ctrl+Shift+Y
 *
 * The clip goes to Hypha's capture inbox, not into the graph directly —
 * the graph lives in the browser profile running Hypha. Blocks appear the
 * next time Hypha is open.
 */

import { createCaptureClient } from "./capture-client.js";
import { buildPageClip } from "./clip.js";
import { getSettings } from "./settings.js";

const client = createCaptureClient({ getSettings });

function notify(message) {
  browser.notifications.create({
    type: "basic",
    title: "Hypha Clipper",
    message,
  });
}

/**
 * Read the current selection out of the tab.
 *
 * Context-menu clicks already carry `selectionText`; the toolbar button and
 * the keyboard shortcut do not, so ask the page. A failure here (about:
 * pages, PDF viewer, missing host permission) is not worth aborting the
 * clip — the page title and URL are still useful.
 */
async function readSelection(tab) {
  try {
    const [selection] = await browser.tabs.executeScript(tab.id, {
      code: "String(window.getSelection())",
    });
    return selection ?? "";
  } catch {
    return "";
  }
}

async function clipTab(tab, selectionText) {
  const selection = selectionText ?? (await readSelection(tab));
  const clip = buildPageClip({ title: tab.title, url: tab.url, selection });

  try {
    await client.capture(clip);
    notify(selection ? "Selection sent to Hypha." : "Page sent to Hypha.");
  } catch (err) {
    notify(err.message);
  }
}

async function clipActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) await clipTab(tab);
}

browser.browserAction.onClicked.addListener((tab) => clipTab(tab));
browser.commands.onCommand.addListener((command) => {
  if (command === "clip-page") clipActiveTab();
});

browser.contextMenus.create({
  id: "hypha-clip",
  title: "Clip to Hypha",
  contexts: ["page", "selection"],
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "hypha-clip" && tab) {
    clipTab(tab, info.selectionText ?? "");
  }
});
