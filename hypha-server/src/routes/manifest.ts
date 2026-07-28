/**
 * Web app manifest.
 *
 * Stock Logseq ships no manifest, so a self-hosted Hypha could only ever be
 * "installed" as a browser shortcut: no standalone window, no Homescreen
 * icon, no share target. Serving one here (rather than committing it to
 * resources/, which is upstream territory) keeps the upstream tree clean.
 *
 * The `share_target` entry is the Android half of Hypha's quick capture:
 * picking Hypha from the system share sheet navigates to start_url with the
 * shared fields appended as query params, which frontend.hypha.capture
 * turns into a block in today's journal. GET (not POST) is deliberate —
 * it keeps the whole capture path client-side, because the graph lives in
 * the browser's OPFS and reaches the server only through RTC sync.
 *
 * The desktop bookmarklet targets the same query-param contract; see
 * docs/hypha/quick-capture.md.
 */

import type { FastifyPluginAsync } from "fastify";

/**
 * Query-param names the share target writes into start_url. Kept under a
 * `hypha-` prefix so they cannot collide with anything upstream Logseq
 * reads off the URL.
 */
export const CAPTURE_PARAMS = {
  title: "hypha-title",
  text: "hypha-text",
  url: "hypha-url",
} as const;

export function buildManifest() {
  return {
    name: "Hypha",
    short_name: "Hypha",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Chrome's installability gate needs a PNG of at least 192x192.
    // resources/img/logo.png is exactly 192x192 and gulp copies it into
    // static/, where the statics route serves it.
    icons: [
      {
        src: "/img/logo.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    share_target: {
      action: "/",
      method: "GET",
      params: CAPTURE_PARAMS,
    },
  };
}

export const manifestRoute: FastifyPluginAsync = async (app) => {
  const body = JSON.stringify(buildManifest());

  app.get("/manifest.webmanifest", async (_request, reply) =>
    reply.type("application/manifest+json; charset=utf-8").send(body));
};
