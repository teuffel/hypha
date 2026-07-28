/**
 * Thunderbird clipper.
 *
 * A button in the message-display toolbar sends the mail you are reading to
 * Hypha's capture inbox: subject, sender, date, and the Message-ID as a
 * `mid:` pointer back.
 *
 * This is why the inbox exists. Thunderbird cannot host Hypha (the app
 * needs OPFS + SharedArrayBuffer behind COEP, which a mail client's content
 * tab does not provide), so the URL-navigation path the browser bookmarklet
 * uses is not available here. Posting to the inbox is the only sane route.
 */

import { createCaptureClient } from "./capture-client.js";
import { buildMessageClip } from "./clip.js";
import { getSettings } from "./settings.js";

const client = createCaptureClient({ getSettings });

function notify(message) {
  browser.notifications.create({
    type: "basic",
    title: "Hypha Clipper",
    message,
  });
}

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  const message = await browser.messageDisplay.getDisplayedMessage(tab.id);
  if (!message) {
    notify("No mail is open.");
    return;
  }

  try {
    await client.capture(buildMessageClip(message));
    notify("Mail sent to Hypha.");
  } catch (err) {
    notify(err.message);
  }
});
