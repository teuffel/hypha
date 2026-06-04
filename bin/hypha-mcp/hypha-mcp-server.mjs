#!/usr/bin/env node
// Thin MCP (stdio) server bridging opencode to a Hypha graph.
//
// Each tool shells out to the built logseq CLI (static/logseq-cli.js) against
// the local RTC-synced replica. Because `hypha-sync-up.sh` already started a
// db-worker-node daemon with db-sync running for this graph, the CLI reuses
// that daemon (ensure-server!), so reads see live data and writes flow through
// apply-outliner-ops -> :db-sync listener -> RTC -> node-adapter -> browsers.
//
// This process holds no DB lock and no RTC connection itself; it is a stateless
// proxy. opencode may spawn it per session while the single daemon stays up.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const CLI = process.env.HYPHA_CLI ?? resolve(REPO, "static", "logseq-cli.js");
const GRAPH = process.env.HYPHA_GRAPH ?? "teuffel.io";
const ROOT = process.env.HYPHA_ROOT ?? resolve(homedir(), ".local", "share", "hypha-cli-graph");
// cli.edn lives at ~/logseq/cli.edn regardless of --root-dir; --config decouples
// the (global) sync config from the (replica) root-dir, so writes hit Hypha.
const CONFIG = process.env.HYPHA_CONFIG ?? resolve(homedir(), "logseq", "cli.edn");

// Run the logseq CLI with graph/config/root-dir always applied. Returns stdout
// text. Non-zero exit becomes an MCP error response (text), never throws.
// Spawns with the same node binary running this process (must be Node >= 22.5
// for the worker's node:sqlite), so opencode launching us with node22 is enough.
function runCli(args) {
  return new Promise((res) => {
    const full = [CLI, ...args, "--graph", GRAPH, "--config", CONFIG, "--root-dir", ROOT];
    const child = spawn(process.execPath, full, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => res({ ok: false, text: `spawn error: ${e.message}` }));
    child.on("close", (code) => {
      if (code === 0) res({ ok: true, text: out.trim() || "(no output)" });
      else res({ ok: false, text: `logseq exited ${code}\n${err.trim() || out.trim()}` });
    });
  });
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
    description: "Create a page (or no-op if it exists). RTC-synced to all clients.",
    inputSchema: { page: z.string().describe("Page name to create") },
  },
  async ({ page }) =>
    mcpText(await runCli(["upsert", "page", "--page", page, "--output", "json"])),
);

server.registerTool(
  "upsert_block",
  {
    title: "Upsert Block",
    description:
      "Create a block on a page (create mode) or rewrite an existing block's content (update mode when id/uuid given). RTC-synced to all clients.",
    inputSchema: {
      content: z.string().describe("Block content (markdown)"),
      targetPage: z.string().optional().describe("Target page name (create mode)"),
      id: z.string().optional().describe("Existing block uuid to update (update mode)"),
    },
  },
  async ({ content, targetPage, id }) => {
    if (id) {
      return mcpText(
        await runCli(["upsert", "block", "--uuid", id, "--content", content, "--output", "json"]),
      );
    }
    if (!targetPage) {
      return mcpText({ ok: false, text: "upsert_block: provide either targetPage (create) or id (update)" });
    }
    return mcpText(
      await runCli([
        "upsert", "block", "--target-page", targetPage, "--content", content, "--output", "json",
      ]),
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
      "(update mode: uuid). Keep status markers OUT of content; use the status field. RTC-synced.",
    inputSchema: {
      content: z.string().optional().describe("Task content (create mode)"),
      targetPage: z.string().optional().describe("Target page name (create mode)"),
      uuid: z.string().optional().describe("Existing task block uuid (update mode)"),
      status: z.string().optional().describe("Task status (e.g. todo, doing, done)"),
      priority: z.string().optional().describe("Task priority (e.g. low, medium, high)"),
      scheduled: z.string().optional().describe("Scheduled datetime, ISO8601"),
      deadline: z.string().optional().describe("Deadline datetime, ISO8601"),
    },
  },
  async ({ content, targetPage, uuid, status, priority, scheduled, deadline }) => {
    const args = ["upsert", "task", "--output", "json"];
    if (uuid) {
      pushOpt(args, "--uuid", uuid);
    } else if (targetPage && content) {
      pushOpt(args, "--target-page", targetPage);
      pushOpt(args, "--content", content);
    } else {
      return mcpText({ ok: false, text: "upsert_task: provide uuid (update) or targetPage+content (create)" });
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
      "Associate tags with an existing block (add/update). Tags must already exist (create them with upsert_tag). RTC-synced.",
    inputSchema: {
      blockUuid: z.string().describe("Block uuid to tag"),
      tags: z.array(z.string()).describe("Tag names/uuids to add"),
      removeTags: z.array(z.string()).optional().describe("Tag names/uuids to remove"),
    },
  },
  async ({ blockUuid, tags, removeTags }) => {
    const args = ["upsert", "block", "--uuid", blockUuid, "--output", "json"];
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
      "property NAMES as keywords (not idents), e.g. '{:mcpnote \"hello\" :rating 5}'. RTC-synced.",
    inputSchema: {
      blockUuid: z.string().describe("Block uuid"),
      propertiesEdn: z.string().describe("EDN map keyed by property name, e.g. {:mcpnote \"hello\"}"),
      removeProperties: z.array(z.string()).optional().describe("Property names to remove"),
    },
  },
  async ({ blockUuid, propertiesEdn, removeProperties }) => {
    const args = ["upsert", "block", "--uuid", blockUuid, "--update-properties", propertiesEdn, "--output", "json"];
    if (removeProperties?.length) args.push("--remove-properties", ednStringVector(removeProperties));
    return mcpText(await runCli(args));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
