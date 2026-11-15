/**
 * Assemble loadable add-ons into dist/.
 *
 * WebExtension manifests cannot reference files outside the add-on root, so
 * the shared client is copied into each flavour instead of being imported
 * across directories. `shared/` stays the single source of truth; dist/ is
 * disposable.
 *
 *   node build.mjs   →   dist/firefox/, dist/thunderbird/
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const flavours = ["firefox", "thunderbird"];

for (const flavour of flavours) {
  const out = join(root, "dist", flavour);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(root, "shared"), out, { recursive: true });
  await cp(join(root, flavour), out, { recursive: true });
  console.log(`built ${flavour} → ${out}`);
}
