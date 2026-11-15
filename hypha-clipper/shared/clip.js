/**
 * Clip construction.
 *
 * A clip is the payload POST /capture accepts: `{ title?, text?, url? }`.
 * The server rejects a clip where all three are absent, so every builder
 * here makes sure at least one field survives.
 *
 * Blank fields are omitted rather than sent as empty strings: Hypha renders
 * them through the quick-capture template, and an empty field would leave a
 * dangling placeholder in the journal.
 */

function clean(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Build a clip from a web page (Firefox). */
export function buildPageClip({ title, url, selection } = {}) {
  const clip = {};
  const cleanTitle = clean(title);
  const cleanUrl = clean(url);
  const cleanSelection = clean(selection);

  if (cleanTitle) clip.title = cleanTitle;
  if (cleanUrl) clip.url = cleanUrl;
  if (cleanSelection) clip.text = cleanSelection;
  return clip;
}

/**
 * Build a clip from a mail (Thunderbird).
 *
 * Mails have no URL, so the RFC 2392 `mid:` form of the Message-ID stands
 * in. It is a stable pointer back to the mail: Thunderbird resolves mid:
 * links, and even without an OS protocol handler the id is searchable.
 *
 * The sender line is always produced, so a subject-less mail still yields
 * a clip the server accepts.
 */
export function buildMessageClip({ subject, author, date, headerMessageId } = {}) {
  const clip = {};
  const cleanSubject = clean(subject);
  const cleanAuthor = clean(author);
  const messageId = clean(headerMessageId);

  if (cleanSubject) clip.title = cleanSubject;
  if (messageId) clip.url = `mid:${messageId}`;

  const day = date instanceof Date && !Number.isNaN(date.valueOf())
    ? date.toISOString().slice(0, 10)
    : undefined;
  if (cleanAuthor) {
    clip.text = day ? `From: ${cleanAuthor} (${day})` : `From: ${cleanAuthor}`;
  }
  return clip;
}
