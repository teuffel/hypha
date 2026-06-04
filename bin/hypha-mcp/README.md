# hypha-mcp

A local MCP bridge that lets an MCP client (e.g. opencode) read and **write**
a Hypha graph, with writes propagating to all browser clients through the
normal RTC/db-sync path (no direct SQLite writes).

## How it works

```
opencode --stdio--> hypha-mcp-server.mjs --exec--> logseq CLI
                                                     |
                                          reuses running db-worker-node daemon
                                          (local replica + open RTC WebSocket)
                                                     v
                       wss://<hypha-host>/sync --> node-adapter --> browsers
```

The headless `db-worker-node` daemon is a normal RTC client (like a browser):
it holds a local replica and an open WebSocket. Any write goes through the
outliner transaction pipeline → the `:db-sync` listener → RTC push → the
server → every connected client within seconds.

**Self-bootstrapping:** on the first tool call the MCP server brings the daemon
up itself (clears any stale lock from a reboot → auth → sync config →
download-if-missing → sync start), so you do not need to start anything by hand.
The daemon is detached and persists across opencode restarts; later startups
just reuse it (warm start ~1s, cold start a few seconds, first-ever run longer
because it downloads the graph). `hypha-sync-up.sh` remains available for manual
pre-warming. Set `HYPHA_NO_BOOTSTRAP=1` to disable auto-bootstrap.

## Requirements

- **Node >= 22.5** (the worker uses the `node:sqlite` builtin). Node 20 will not
  work. Set `HYPHA_NODE` to a Node 22 binary if your default `node` is older.
- Built artifacts in the repo: `static/logseq-cli.js` and
  `static/js/db-worker-node.js`. Build them **with the literal-slash define**
  (Patch #15) so the CLI/worker match the Hypha web build:
  ```sh
  clojure -M:cljs release logseq-cli db-worker-node \
    --config-merge '{:closure-defines {logseq.common.util.namespace/HYPHA-LITERAL-SLASH true}}'
  node ./scripts/build-db-worker-node-bundle.mjs
  ln -sf ../db-worker-node.js static/js/db-worker-node.js
  ```
  (logseq-cli and db-worker-node must be built from the same commit so their
  revisions match, otherwise the CLI refuses to talk to the worker.)

## Secrets stay OUT of this repo

This directory contains **no** credentials. At runtime, two files live in your
home directory and must never be committed:

- `~/.config/hypha/access-code` — your plaintext Hypha access code (you create it).
- `~/logseq/auth.json` — the short-lived id-token, written by `hypha-auth.mjs`.

## Setup

```sh
# 1. one-time: store your access code (outside the repo)
echo 'YOUR-ACCESS-CODE' > ~/.config/hypha/access-code && chmod 600 ~/.config/hypha/access-code

# 2. install this bridge's deps
pnpm install            # in bin/hypha-mcp
```

That's it — the MCP server self-bootstraps the synced daemon on first use.
Register it with your MCP client; for opencode (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "hypha-notes": {
      "type": "local",
      "command": ["/path/to/node22/bin/node", "/path/to/repo/bin/hypha-mcp/hypha-mcp-server.mjs"],
      "enabled": true,
      "timeout": 120000,
      "environment": { "HYPHA_GRAPH": "<your-graph>" }
    }
  }
}
```

`timeout` is generous so the first cold tool call (which may download the graph)
does not exceed the MCP request timeout.

## Configuration (env vars, all optional)

| Var            | Default                              | Meaning                              |
| -------------- | ------------------------------------ | ------------------------------------ |
| `HYPHA_URL`    | `https://notes.teuffel.io`           | Hypha server base URL                |
| `HYPHA_GRAPH`  | `teuffel.io`                         | Graph name                           |
| `HYPHA_WS_URL` | `wss://notes.teuffel.io/sync/%s`     | RTC WebSocket URL (`%s` = graph id)  |
| `HYPHA_ROOT`   | `~/.local/share/hypha-cli-graph`     | Local replica root dir               |
| `HYPHA_CONFIG` | `~/logseq/cli.edn`                   | logseq CLI sync config path          |
| `HYPHA_NODE`   | `~/.local/node22/bin/node`           | Node >= 22.5 binary                  |

Override `HYPHA_URL`/`HYPHA_GRAPH`/`HYPHA_WS_URL` for a different Hypha instance.

## Tools

Read: `get_page`, `list_pages`, `search_blocks`, `list_tasks`, `list_tags`,
`list_properties`.
Create/update (RTC-synced): `upsert_page`, `upsert_block`, `upsert_blocks`,
`upsert_task`, `upsert_tag`, `set_block_tags`, `upsert_property`,
`set_block_properties`, `set_page_parent`.
Delete (RTC-synced): `remove_block`, `remove_page`, `remove_tag`,
`remove_property`.

Notes:
- **Literal "/" + namespaces (Patch #15):** in Hypha builds "/" is a literal
  character in page titles (e.g. `2024/Q3`), so titles are never split
  into a hierarchy. Build a hierarchy explicitly with `set_page_parent` (or the
  `parent` field of `upsert_page`); a child page is then referenced by its leaf
  title or `id`/`uuid` (not by a `Parent/Child` path). `remove_parent` / a
  `removeParent: true` makes a page top-level again.
- **Tagging / properties on pages:** a page is a node too. `upsert_page` accepts
  `tags`/`removeTags` and `propertiesEdn`/`removeProperties` (target by page name
  or `id`), so you can tag a page and set page-level properties in one call.
- **Editing existing blocks:** the block tools that target an existing block
  (`upsert_block`/`upsert_task` update mode, `set_block_tags`,
  `set_block_properties`, `remove_block`) accept either `id` (the `db/id`
  returned by the read tools) or `uuid`. So you can read a page and edit/delete
  its blocks directly by `id`.
- `upsert_blocks` creates a nested block tree in one call, e.g.
  `[{"title":"Obst","children":[{"title":"Äpfel"}]},{"title":"Brot"}]`. Prefer
  it over many `upsert_block` calls for structured/hierarchical content.
- Tags/properties must exist before associating them with a block
  (`upsert_tag` / `upsert_property` first).
- `set_block_properties` takes an EDN map keyed by property **name** keywords,
  e.g. `{:mcpnote "hello"}`.
