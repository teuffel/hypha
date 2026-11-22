/**
 * Static asset serving.
 *
 * Phase-1 Hypha builds the Logseq frontend with the full pipeline
 *   (`gulp build` + `cljs:release-app` + `webpack-app-build`)
 * and the resulting bundle is the workspace `static/` tree. In production
 * (M3, Docker image) `static/` is the only thing the browser needs.
 *
 * resources/index.html ships with the gulp output as static/index.html, so
 * serving static/ alone is sufficient. The one exception is index.html
 * itself, which this module serves from memory with the PWA manifest link
 * injected — see injectManifestLink below.
 *
 * In M1 we wire the route up but do not yet exercise it from a browser —
 * the M1 DoD items that require a real browser are verified manually after
 * M3 brings up the Docker image. See docs/hypha/phase-1-plan.md M1/M3.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";

/**
 * Where the browser reaches the plugin-assets listener (plugin-app.ts).
 * Exactly one of the two is used by the frontend:
 *   - `origin`: full public origin, for reverse-proxy setups
 *     (e.g. "https://plugins.hypha.example.com").
 *   - `port`: the frontend combines it with the protocol + hostname the
 *     app itself was loaded from (zero-config for localhost / LAN use).
 */
export interface PluginFrontendLocation {
  origin?: string;
  port?: number;
}

interface StaticsDeps {
  /** Absolute path to the workspace `static/` directory. */
  staticDir: string;
  /**
   * Injected into index.html as a <meta> tag so frontend.hypha.plugin-init
   * can read it synchronously — no inline script, no config fetch, no patch
   * against upstream's resources/index.html.
   */
  pluginFrontend?: PluginFrontendLocation;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function pluginMetaTag(loc: PluginFrontendLocation | undefined): string {
  if (!loc) return "";
  if (loc.origin) {
    return `<meta name="hypha-plugin-origin" content="${escapeAttr(loc.origin)}">`;
  }
  if (loc.port !== undefined) {
    return `<meta name="hypha-plugin-port" content="${escapeAttr(String(loc.port))}">`;
  }
  return "";
}

export function injectPluginMeta(html: string, loc: PluginFrontendLocation | undefined): string {
  const tag = pluginMetaTag(loc);
  if (tag.length === 0) return html;
  if (!html.includes("</head>")) {
    throw new Error("statics: index.html has no </head> to inject the plugin-origin meta tag into");
  }
  return html.replace("</head>", `  ${tag}\n</head>`);
}

const MANIFEST_LINK = '<link rel="manifest" href="/manifest.webmanifest">';

/**
 * Add the PWA manifest link to the built index.html.
 *
 * Done at serve time instead of in resources/index.html so the upstream
 * tree stays untouched (HYPHA_PATCHES.md keeps a hard budget on upstream
 * edits). A page-load-time link is required: browsers evaluate
 * installability from the markup they receive, and a manifest injected
 * later from ClojureScript is not reliably picked up.
 *
 * Idempotent, so an upstream that starts shipping its own manifest link
 * silently wins instead of producing two.
 */
export function injectManifestLink(html: string): string {
  if (html.includes('rel="manifest"')) return html;
  if (!html.includes("</head>")) {
    throw new Error("statics: index.html has no </head> to inject the PWA manifest link into");
  }
  return html.replace("</head>", `  ${MANIFEST_LINK}\n</head>`);
}

export const staticsRoute: FastifyPluginAsync<StaticsDeps> = async (app, deps) => {
  const root = resolve(deps.staticDir);

  // index.html is a build artifact and never changes while the process
  // lives, so read + inject once at registration rather than per request.
  const indexHtml = injectPluginMeta(
    injectManifestLink(await readFile(join(root, "index.html"), "utf8")),
    deps.pluginFrontend,
  );

  app.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(indexHtml));
  app.get("/index.html", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(indexHtml));

  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    decorateReply: false,
    // The two routes above own index.html; leaving fastify-static's own
    // index handling on would collide with them.
    index: false,
  });
};
