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

## Requirements

- **Node >= 22.5** (the worker uses the `node:sqlite` builtin). Node 20 will not
  work. Set `HYPHA_NODE` to a Node 22 binary if your default `node` is older.
- Built artifacts in the repo: `static/logseq-cli.js` and
  `static/js/db-worker-node.js` (build with
  `clojure -M:cljs release logseq-cli db-worker-node && node ./scripts/build-db-worker-node-bundle.mjs`,
  then `ln -sf ../db-worker-node.js static/js/db-worker-node.js`).

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

# 3. bring up the synced daemon (run once per session; it stays running)
./hypha-sync-up.sh      # expect "ws-state":"open"
```

Then register it with your MCP client. For opencode (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "hypha-notes": {
      "type": "local",
      "command": ["/path/to/node22/bin/node", "/path/to/repo/bin/hypha-mcp/hypha-mcp-server.mjs"],
      "enabled": true,
      "environment": { "HYPHA_GRAPH": "<your-graph>" }
    }
  }
}
```

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
Write (RTC-synced): `upsert_page`, `upsert_block`, `upsert_task`, `upsert_tag`,
`set_block_tags`, `upsert_property`, `set_block_properties`.

Notes:
- Tags/properties must exist before associating them with a block
  (`upsert_tag` / `upsert_property` first).
- `set_block_properties` takes an EDN map keyed by property **name** keywords,
  e.g. `{:mcpnote "hello"}`.
