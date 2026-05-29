/**
 * Static asset serving.
 *
 * Phase-1 Hypha builds the Logseq frontend with the full pipeline
 *   (`gulp build` + `cljs:release-app` + `webpack-app-build`)
 * and the resulting bundle is the workspace `static/` tree. In production
 * (M3, Docker image) `static/` is the only thing the browser needs.
 *
 * resources/index.html ships with the gulp output as static/index.html, so
 * serving static/ alone is sufficient.
 *
 * In M1 we wire the route up but do not yet exercise it from a browser —
 * the M1 DoD items that require a real browser are verified manually after
 * M3 brings up the Docker image. See docs/hypha/phase-1-plan.md M1/M3.
 */

import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";

interface StaticsDeps {
  /** Absolute path to the workspace `static/` directory. */
  staticDir: string;
}

export const staticsRoute: FastifyPluginAsync<StaticsDeps> = async (app, deps) => {
  await app.register(fastifyStatic, {
    root: resolve(deps.staticDir),
    prefix: "/",
    decorateReply: false,
    index: "index.html",
  });
};
