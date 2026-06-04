#!/usr/bin/env node
// Thin MCP (stdio) server bridging opencode to a Hypha graph.
//
// Self-bootstrapping (like the redmine MCP that `docker run`s its server): on
// the FIRST tool call this process brings up the RTC-synced db-worker-node
// daemon itself (auth -> sync config -> download-if-missing -> sync start), so
// you do NOT need to run hypha-sync-up.sh first. The daemon is detached and
// persists across opencode restarts; subsequent startups just reuse it.
//
// Each tool shells out to the built logseq CLI (static/logseq-cli.js) against
// the local replica. The daemon holds the DB lock + RTC connection; this proxy
// is otherwise stateless. Reads see live data; writes flow through
// apply-outliner-ops -> :db-sync listener -> RTC -> node-adapter -> browsers.
//
// IMPORTANT: never write to stdout here (it carries the JSON-RPC stream). All
// diagnostics go to stderr. The MCP handshake returns immediately; bootstrap is
// lazy, so set a generous `timeout` on the opencode mcp entry for cold starts.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const CLI = process.env.HYPHA_CLI ?? resolve(REPO, "static", "logseq-cli.js");
const AUTH = resolve(HERE, "hypha-auth.mjs");
const GRAPH = process.env.HYPHA_GRAPH ?? "teuffel.io";
const ROOT = process.env.HYPHA_ROOT ?? resolve(homedir(), ".local", "share", "hypha-cli-graph");
// cli.edn lives at ~/logseq/cli.edn regardless of --root-dir; --config decouples
// the (global) sync config from the (replica) root-dir, so writes hit Hypha.
const CONFIG = process.env.HYPHA_CONFIG ?? resolve(homedir(), "logseq", "cli.edn");
const HYPHA_URL = process.env.HYPHA_URL ?? "https://notes.teuffel.io";
const WS_URL = process.env.HYPHA_WS_URL ?? "wss://notes.teuffel.io/sync/%s";
const DB_PATH = join(ROOT, "graphs", GRAPH, "db.sqlite");
const LOCK_PATH = join(ROOT, "graphs", GRAPH, "db-worker.lock");
const NO_BOOTSTRAP = process.env.HYPHA_NO_BOOTSTRAP === "1";

const log = (...m) => console.error("[hypha-mcp]", ...m);

// Spawn a node script/CLI and collect stdout. Never throws.
function run(scriptArgs, { extraEnv } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, scriptArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => res({ ok: false, text: `spawn error: ${e.message}` }));
    child.on("close", (code) =>
      res(code === 0 ? { ok: true, text: out.trim() || "(no output)" } : { ok: false, text: `exited ${code}\n${err.trim() || out.trim()}` }),
    );
  });
}

// Run the logseq CLI with graph/config/root-dir always applied (no bootstrap).
// Spawns with the same node binary running this process (must be Node >= 22.5
// for the worker's node:sqlite), so opencode launching us with node22 is enough.
const runCliRaw = (args) => run([CLI, ...args, "--graph", GRAPH, "--config", CONFIG, "--root-dir", ROOT]);

// --- Self-bootstrap --------------------------------------------------------
// Idempotent bring-up of the RTC-synced daemon. We do NOT pre-check status
// (that would spawn a worker just to ask, and can stall on a stale lock from an
// unclean shutdown). Instead we always run the sequence: when the daemon is
// already up and synced every step is a fast no-op (sync start returns "open"
// in ~1s); when cold it auth/config/download(once)/start. `server cleanup`
// first clears any orphaned server-list entry left by a reboot/kill.
let bootstrapPromise = null;

// Remove a db-worker lock left behind by an unclean shutdown (e.g. reboot).
// Only removes it when the owning pid is dead, so it never steals a live lock.
// A stale lock otherwise makes the next cold spawn hang on orphan recovery.
function clearStaleLock() {
  if (!existsSync(LOCK_PATH)) return;
  try {
    const pid = JSON.parse(readFileSync(LOCK_PATH, "utf8")).pid;
    if (typeof pid !== "number") return;
    try {
      process.kill(pid, 0); // alive -> keep lock
    } catch {
      unlinkSync(LOCK_PATH); // dead pid -> stale lock, remove it
      log(`removed stale db-worker lock (dead pid ${pid})`);
    }
  } catch (e) {
    log("could not inspect lock file:", e.message);
  }
}

async function bootstrap() {
  if (NO_BOOTSTRAP) {
    log("HYPHA_NO_BOOTSTRAP=1, skipping bootstrap");
    return;
  }
  log("ensuring synced daemon (cleanup stale entries)...");
  clearStaleLock();
  await runCliRaw(["server", "cleanup"]); // best-effort; ignore result

  log("auth...");
  const auth = await run([AUTH], { extraEnv: { HYPHA_URL } });
  if (!auth.ok) throw new Error(`auth failed: ${auth.text}`);

  await runCliRaw(["sync", "config", "set", "ws-url", WS_URL]);
  await runCliRaw(["sync", "config", "set", "http-base", HYPHA_URL]);

  if (!existsSync(DB_PATH)) {
    log("downloading graph (first run, may take a while)...");
    const dl = await runCliRaw(["sync", "download", "--progress"]);
    if (!dl.ok) throw new Error(`download failed: ${dl.text}`);
  }

  log("sync start...");
  const start = await runCliRaw(["sync", "start", "--output", "json"]);
  if (!start.ok) throw new Error(`sync start failed: ${start.text}`);
  log(/"ws-state":"open"/.test(start.text) ? "sync ready (ws-state open)" : "sync started (ws-state not yet open)");
}

// Memoized; every tool awaits this so the first call brings sync up.
function ensureReady() {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().catch((e) => {
      bootstrapPromise = null; // allow retry on next tool call
      throw e;
    });
  }
  return bootstrapPromise;
}

// Tool entrypoint: ensure sync, then run the CLI. Bootstrap errors surface as
// an MCP error response rather than crashing the server.
async function runCli(args) {
  try {
    await ensureReady();
  } catch (e) {
    return { ok: false, text: `hypha sync bootstrap failed: ${e.message}` };
  }
  return runCliRaw(args);
}

function mcpText({ ok, text }) {
  return { content: [{ type: "text", text }], ...(ok ? {} : { isError: true }) };
}

// Serialize a JS string array to an EDN vector of strings, e.g.
// ["AI-GENERATED","CLI"] -> ["AI-GENERATED" "CLI"]. Used for --update-tags.
function ednStringVector(items) {
  const esc = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `[${items.map(esc).join(" ")}]`;
}

// Push an optional flag/value pair onto an args array when the value is set.
function pushOpt(args, flag, value) {
  if (value !== undefined && value !== null && value !== "") args.push(flag, String(value));
}

// Pick the CLI flag for targeting an existing entity. Read tools expose
// `db/id`, so we accept either `id` (db/id) or `uuid`. Returns [] when neither
// is given (caller decides whether that's create-mode or an error).
function entitySelector({ id, uuid }) {
  if (uuid) return ["--uuid", String(uuid)];
  if (id !== undefined && id !== null && String(id) !== "") return ["--id", String(id)];
  return [];
}

// Serialize a nested block tree ([{title, children?}]) to the EDN vector the
// `logseq upsert block --blocks` flag expects, e.g.
//   [{:block/title "Obst" :block/children [{:block/title "Äpfel"}]}]
function ednBlockTree(nodes) {
  const esc = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const node = (n) => {
    let s = `{:block/title ${esc(n.title)}`;
    if (n.children && n.children.length) s += ` :block/children [${n.children.map(node).join(" ")}]`;
    return s + "}";
  };
  return `[${nodes.map(node).join(" ")}]`;
}

const server = new McpServer({ name: "Hypha MCP Server", version: "0.1.0" });

server.registerTool(
  "get_page",
  {
    title: "Get Page",
    description: "Get a page's content tree (blocks). A tag or property is also a page.",
    inputSchema: { pageName: z.string().describe("The page's name") },
  },
  async ({ pageName }) =>
    mcpText(await runCli(["show", "--page", pageName, "--output", "json"])),
);

server.registerTool(
  "list_pages",
  {
    title: "List Pages",
    description: "List pages in the graph.",
    inputSchema: {
      limit: z.number().int().optional().describe("Max number of pages"),
    },
  },
  async ({ limit }) => {
    const args = ["list", "page", "--output", "json"];
    if (limit) args.push("--limit", String(limit));
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "search_blocks",
  {
    title: "Search Blocks",
    description: "Search the graph for blocks whose content contains the search term.",
    inputSchema: { searchTerm: z.string().describe("Text to search for") },
  },
  async ({ searchTerm }) =>
    mcpText(await runCli(["search", "block", "--content", searchTerm, "--output", "json"])),
);

server.registerTool(
  "upsert_page",
  {
    title: "Upsert Page",
    description:
      "Create a page (or update an existing one) and optionally set its tags and properties. " +
      "A page IS a node, so it can carry tags/properties just like a block. Target by page name " +
      "or id (db/id from read tools). Tags/properties must already exist (upsert_tag/upsert_property). " +
      "RTC-synced.",
    inputSchema: {
      page: z.string().optional().describe("Page name (create, or target an existing page by name)"),
      id: z.union([z.number(), z.string()]).optional().describe("Existing page db/id (update mode)"),
      tags: z.array(z.string()).optional().describe("Tag names/uuids to add"),
      removeTags: z.array(z.string()).optional().describe("Tag names/uuids to remove"),
      propertiesEdn: z.string().optional().describe("EDN map keyed by property name, e.g. {:mcpnote \"hello\"}"),
      removeProperties: z.array(z.string()).optional().describe("Property names to remove"),
    },
  },
  async ({ page, id, tags, removeTags, propertiesEdn, removeProperties }) => {
    const hasId = id !== undefined && id !== null && String(id) !== "";
    const sel = hasId ? ["--id", String(id)] : page ? ["--page", page] : [];
    if (!sel.length) return mcpText({ ok: false, text: "upsert_page: provide page (name) or id" });
    const args = ["upsert", "page", ...sel, "--output", "json"];
    if (tags?.length) args.push("--update-tags", ednStringVector(tags));
    if (removeTags?.length) args.push("--remove-tags", ednStringVector(removeTags));
    if (propertiesEdn) args.push("--update-properties", propertiesEdn);
    if (removeProperties?.length) args.push("--remove-properties", ednStringVector(removeProperties));
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "upsert_block",
  {
    title: "Upsert Block",
    description:
      "Create a block on a page (create mode: targetPage) or rewrite an existing block's content " +
      "(update mode: id or uuid). id is the db/id returned by read tools; uuid also works. RTC-synced.",
    inputSchema: {
      content: z.string().describe("Block content (markdown)"),
      targetPage: z.string().optional().describe("Target page name (create mode)"),
      id: z.union([z.number(), z.string()]).optional().describe("Existing block db/id (update mode)"),
      uuid: z.string().optional().describe("Existing block uuid (update mode)"),
    },
  },
  async ({ content, targetPage, id, uuid }) => {
    const sel = entitySelector({ id, uuid });
    if (sel.length) {
      return mcpText(await runCli(["upsert", "block", ...sel, "--content", content, "--output", "json"]));
    }
    if (!targetPage) {
      return mcpText({ ok: false, text: "upsert_block: provide targetPage (create) or id/uuid (update)" });
    }
    return mcpText(
      await runCli(["upsert", "block", "--target-page", targetPage, "--content", content, "--output", "json"]),
    );
  },
);

const blockNode = z.lazy(() =>
  z.object({
    title: z.string().describe("Block content (markdown)"),
    children: z.array(blockNode).optional().describe("Nested child blocks"),
  }),
);

server.registerTool(
  "upsert_blocks",
  {
    title: "Upsert Blocks (tree)",
    description:
      "Create multiple blocks at once on a page, including nested children, in a single operation. " +
      "Use this for structured content (lists, outlines, hierarchies) instead of many upsert_block calls. RTC-synced. " +
      'Example blocks: [{"title":"Obst","children":[{"title":"Äpfel"},{"title":"Bananen"}]},{"title":"Brot"}]',
    inputSchema: {
      targetPage: z.string().describe("Target page name"),
      blocks: z.array(blockNode).describe("Nested block tree to insert"),
    },
  },
  async ({ targetPage, blocks }) => {
    if (!blocks.length) return mcpText({ ok: false, text: "upsert_blocks: blocks is empty" });
    return mcpText(
      await runCli(["upsert", "block", "--target-page", targetPage, "--blocks", ednBlockTree(blocks), "--output", "json"]),
    );
  },
);

// ---- Tasks ----------------------------------------------------------------

server.registerTool(
  "list_tasks",
  {
    title: "List Tasks",
    description: "List tasks, optionally filtered by status, priority, or content.",
    inputSchema: {
      status: z.string().optional().describe("Filter by status (e.g. todo, doing, done)"),
      priority: z.string().optional().describe("Filter by priority (e.g. low, medium, high)"),
      content: z.string().optional().describe("Filter by task title content"),
      limit: z.number().int().optional().describe("Max number of tasks"),
    },
  },
  async ({ status, priority, content, limit }) => {
    const args = ["list", "task", "--output", "json"];
    pushOpt(args, "--status", status);
    pushOpt(args, "--priority", priority);
    pushOpt(args, "--content", content);
    pushOpt(args, "--limit", limit);
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "upsert_task",
  {
    title: "Upsert Task",
    description:
      "Create a task on a page (create mode: targetPage + content) or update an existing task " +
      "(update mode: id or uuid). id is the db/id from read tools. Keep status markers OUT of " +
      "content; use the status field. RTC-synced.",
    inputSchema: {
      content: z.string().optional().describe("Task content (create mode)"),
      targetPage: z.string().optional().describe("Target page name (create mode)"),
      id: z.union([z.number(), z.string()]).optional().describe("Existing task db/id (update mode)"),
      uuid: z.string().optional().describe("Existing task block uuid (update mode)"),
      status: z.string().optional().describe("Task status (e.g. todo, doing, done)"),
      priority: z.string().optional().describe("Task priority (e.g. low, medium, high)"),
      scheduled: z.string().optional().describe("Scheduled datetime, ISO8601"),
      deadline: z.string().optional().describe("Deadline datetime, ISO8601"),
    },
  },
  async ({ content, targetPage, id, uuid, status, priority, scheduled, deadline }) => {
    const args = ["upsert", "task", "--output", "json"];
    const sel = entitySelector({ id, uuid });
    if (sel.length) {
      args.push(...sel);
    } else if (targetPage && content) {
      pushOpt(args, "--target-page", targetPage);
      pushOpt(args, "--content", content);
    } else {
      return mcpText({ ok: false, text: "upsert_task: provide id/uuid (update) or targetPage+content (create)" });
    }
    pushOpt(args, "--status", status);
    pushOpt(args, "--priority", priority);
    pushOpt(args, "--scheduled", scheduled);
    pushOpt(args, "--deadline", deadline);
    return mcpText(await runCli(args));
  },
);

// ---- Tags -----------------------------------------------------------------

server.registerTool(
  "list_tags",
  {
    title: "List Tags",
    description: "List tags in the graph.",
    inputSchema: { limit: z.number().int().optional().describe("Max number of tags") },
  },
  async ({ limit }) => {
    const args = ["list", "tag", "--output", "json"];
    pushOpt(args, "--limit", limit);
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "upsert_tag",
  {
    title: "Upsert Tag",
    description: "Create a tag (or rename when id given). Tags must exist before associating them with blocks. RTC-synced.",
    inputSchema: {
      name: z.string().describe("Tag name"),
      id: z.string().optional().describe("Existing tag db/id to rename (update mode)"),
    },
  },
  async ({ name, id }) => {
    const args = ["upsert", "tag", "--name", name, "--output", "json"];
    pushOpt(args, "--id", id);
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "set_block_tags",
  {
    title: "Set Block Tags",
    description:
      "Associate tags with an existing block (add/update). Identify the block by id (db/id from " +
      "read tools) or uuid. Tags must already exist (create them with upsert_tag). RTC-synced.",
    inputSchema: {
      id: z.union([z.number(), z.string()]).optional().describe("Block db/id"),
      uuid: z.string().optional().describe("Block uuid"),
      tags: z.array(z.string()).describe("Tag names/uuids to add"),
      removeTags: z.array(z.string()).optional().describe("Tag names/uuids to remove"),
    },
  },
  async ({ id, uuid, tags, removeTags }) => {
    const sel = entitySelector({ id, uuid });
    if (!sel.length) return mcpText({ ok: false, text: "set_block_tags: provide id or uuid" });
    const args = ["upsert", "block", ...sel, "--output", "json"];
    if (tags?.length) args.push("--update-tags", ednStringVector(tags));
    if (removeTags?.length) args.push("--remove-tags", ednStringVector(removeTags));
    return mcpText(await runCli(args));
  },
);

// ---- Properties -----------------------------------------------------------

server.registerTool(
  "list_properties",
  {
    title: "List Properties",
    description: "List properties in the graph.",
    inputSchema: { limit: z.number().int().optional().describe("Max number of properties") },
  },
  async ({ limit }) => {
    const args = ["list", "property", "--output", "json"];
    pushOpt(args, "--limit", limit);
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "upsert_property",
  {
    title: "Upsert Property",
    description:
      "Create a property (or update when id given). A property must exist before setting it on a block. RTC-synced.",
    inputSchema: {
      name: z.string().describe("Property name"),
      type: z.string().optional().describe("Property type (e.g. default, number, date, checkbox, node)"),
      cardinality: z.enum(["one", "many"]).optional().describe("Property cardinality"),
      public: z.boolean().optional().describe("Public visibility"),
      id: z.string().optional().describe("Existing property db/id (update mode)"),
    },
  },
  async ({ name, type, cardinality, public: isPublic, id }) => {
    const args = ["upsert", "property", "--name", name, "--output", "json"];
    pushOpt(args, "--type", type);
    pushOpt(args, "--cardinality", cardinality);
    pushOpt(args, "--id", id);
    if (isPublic !== undefined) args.push("--public", String(isPublic));
    return mcpText(await runCli(args));
  },
);

server.registerTool(
  "set_block_properties",
  {
    title: "Set Block Properties",
    description:
      "Set/update properties on an existing block. Each property must already exist " +
      "(create it with upsert_property first). propertiesEdn is a raw EDN map whose keys are " +
      "property NAMES as keywords (not idents), e.g. '{:mcpnote \"hello\" :rating 5}'. " +
      "Identify the block by id (db/id from read tools) or uuid. RTC-synced.",
    inputSchema: {
      id: z.union([z.number(), z.string()]).optional().describe("Block db/id"),
      uuid: z.string().optional().describe("Block uuid"),
      propertiesEdn: z.string().describe("EDN map keyed by property name, e.g. {:mcpnote \"hello\"}"),
      removeProperties: z.array(z.string()).optional().describe("Property names to remove"),
    },
  },
  async ({ id, uuid, propertiesEdn, removeProperties }) => {
    const sel = entitySelector({ id, uuid });
    if (!sel.length) return mcpText({ ok: false, text: "set_block_properties: provide id or uuid" });
    const args = ["upsert", "block", ...sel, "--update-properties", propertiesEdn, "--output", "json"];
    if (removeProperties?.length) args.push("--remove-properties", ednStringVector(removeProperties));
    return mcpText(await runCli(args));
  },
);

// ---- Delete ---------------------------------------------------------------

server.registerTool(
  "remove_block",
  {
    title: "Remove Block",
    description: "Delete a block (and its children) by id (db/id from read tools) or uuid. RTC-synced.",
    inputSchema: {
      id: z.union([z.number(), z.string()]).optional().describe("Block db/id"),
      uuid: z.string().optional().describe("Block uuid"),
    },
  },
  async ({ id, uuid }) => {
    const sel = entitySelector({ id, uuid });
    if (!sel.length) return mcpText({ ok: false, text: "remove_block: provide id or uuid" });
    return mcpText(await runCli(["remove", "block", ...sel, "--output", "json"]));
  },
);

server.registerTool(
  "remove_page",
  {
    title: "Remove Page",
    description: "Delete a page and all its blocks by name. RTC-synced.",
    inputSchema: { page: z.string().describe("Page name to delete") },
  },
  async ({ page }) =>
    mcpText(await runCli(["remove", "page", "--page", page, "--output", "json"])),
);

server.registerTool(
  "remove_tag",
  {
    title: "Remove Tag",
    description: "Delete a tag by name. RTC-synced.",
    inputSchema: { name: z.string().describe("Tag name to delete") },
  },
  async ({ name }) =>
    mcpText(await runCli(["remove", "tag", "--name", name, "--output", "json"])),
);

server.registerTool(
  "remove_property",
  {
    title: "Remove Property",
    description: "Delete a property by name. RTC-synced.",
    inputSchema: { name: z.string().describe("Property name to delete") },
  },
  async ({ name }) =>
    mcpText(await runCli(["remove", "property", "--name", name, "--output", "json"])),
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Warm up the synced daemon right after connecting (non-blocking, so the MCP
// handshake stays instant). The first tool call awaits the same promise.
ensureReady().catch((e) => log("bootstrap error (will retry on tool use):", e.message));
