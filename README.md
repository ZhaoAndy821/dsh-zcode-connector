# DSH ZCode Connector

Use the **ZCode (Z.ai) desktop app** as a model channel from **DeepSeek Harness (DSH)** — by
driving the app's own GUI over Chrome DevTools Protocol, not by pretending it is an API key.

It ships three things:

| Piece | What it does |
|---|---|
| `bridge/zcode-bridge.mjs` | Local OpenAI-compatible endpoint (`POST /v1/chat/completions`) that types a prompt into the running ZCode window, waits for the turn to finish, and returns the answer |
| plugin `dsh-zcode-connect` | Host half with a loopback status route + a self-contained HTML panel (account, plan, live quota, loaded capabilities, what this connector installed) |
| `mcp/server.mjs` | MCP stdio server exposing status, ask, and provisioning tools to any MCP client (DSH consumes it through `@deepseek-ai/dsh-mcp-client`) |

## Why drive the GUI instead of using an API key

Measured on a real install, not inferred:

- ZCode's promo grants (for example `ZCode Weekend Build`, 300,000,000 `GLM-5.3-Flash` tokens) are
  declared in the client's own catalog as **account-bound**:
  `"access": { "type": "zhipu-account", "mode": "start-plan" }`. **There is no API key to extract.**
- The only inference route for such a grant,
  `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`, accepts the account token but
  answers `{"code":3007,"msg":"captcha verify failed"}` without `X-Aliyun-Captcha-Verify-Param` —
  an Aliyun traceless-captcha proof minted **per request inside ZCode's renderer**.
- The documented platform routes do not carry the grant: with the same account,
  `https://open.bigmodel.cn/api/anthropic` and `/api/coding/paas/v4` answer
  `{"code":"1113","message":"余额不足或无可用资源包,请充值。"}`, and the ZCode account token is `401`
  on `https://api.z.ai/api/anthropic`.

So the honest way to spend that quota from your own tooling is to **let the first-party client make
the call** and drive its UI. That is what this project does. It does not forge the attestation.

## Requirements

- ZCode desktop, launched with a debug port: `ZCode.exe --remote-debugging-port=9333`
  (the window may be minimised; it must stay running)
- Node.js 20+ (the bridge and MCP server use the built-in `fetch`)
- DeepSeek Harness, if you want the plugin half

## Install

### 1. The bridge

```bash
node bridge/zcode-bridge.mjs           # listens on 127.0.0.1:9444
```

`POST /v1/chat/completions` (OpenAI-shaped, non-streaming). `GET /healthz` reports the queue depth.

### 2. The plugin (DSH)

Copy this directory somewhere stable, then in your profile:

```jsonc
// <profile>/package.json
"dependencies": { "dsh-zcode-connect": "link:/absolute/path/to/dsh-zcode-connector" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-zcode-connect" ] } }
```

The plugin imports `@deepseek-ai/schemastery`, so a package outside the profile tree needs a
dependency bridge: `<repo>/node_modules/@deepseek-ai` →
`<dsh-home>/profiles/node_modules/@deepseek-ai`.

```yaml
# <profile>/cordis.patch.yml
- id: zcode-connect
  name: dsh-zcode-connect
  config:
    debugPort: 9333      # ZCode's --remote-debugging-port
    bridgePort: 9444     # the bridge above
```

### 3. The MCP server (optional, but this is the convenient surface)

```yaml
- id: mcp-zcode
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: zcode
    command: node
    args: ['/absolute/path/to/dsh-zcode-connector/mcp/server.mjs']
    toolCallTimeoutMs: 300000
    failOnStartupError: false
```

Tools then appear as `mcp__zcode__<name>`:

| Tool | Purpose | Spends quota |
|---|---|---|
| `zcode_status` | account, plan, live remaining quota, loaded channels | no |
| `zcode_ask` | one prompt → `GLM-5.3-Flash` → the reply | **yes** |
| `zcode_install_skill` | install a skill into the client (`~/.zcode/skills/<name>/SKILL.md`) | no |
| `zcode_install_agent` | install a user-level subagent role (`~/.zcode/agents/<name>.md`) | no |
| `zcode_install_mcp` | install an MCP server for the client (`~/.zcode/cli/config.json` → `mcp.servers`) | no |
| `zcode_capabilities` | list what this connector installed | no |
| `zcode_uninstall` | remove an installed skill / agent / MCP server | no |

## Where the connector writes things

Locations are taken from the client's own `zcode-guide:diagnosing-mcp` material, not guessed:

| Scope | File | Field |
|---|---|---|
| Skills | `~/.zcode/skills/<name>/SKILL.md` | frontmatter `name` + `description` |
| Subagents | `~/.zcode/agents/<name>.md` | frontmatter `name`, `description`, `tools`, `model` |
| MCP (user) | `~/.zcode/cli/config.json` | `mcp.servers` |
| MCP (workspace) | `<dir>/.zcode/config.json` or `<dir>/zcode.json` | `mcp.servers` |
| MCP (plugin) | `<pluginRoot>/.mcp.json` | namespaced `plugin:<plugin>:<server>` |

Two rules the client states explicitly and this repo obeys: the MCP server schema is **strict**
(one unknown key and the server is dropped — only the documented fields are written), and template
variables are expanded **only** for plugin-provided servers (so file-scope servers use absolute
paths).

## Constraints (all measured)

- **The client must be running** with the debug port; the window may be minimised.
- **Serial**: one conversation, one input box. The bridge queues; it does not parallelise.
- **One new task per call** — the client keeps no history between calls, so send full context.
- **Channel must be `Start Plan`.** The bridge checks the composer's model label every call and
  switches it if it reads the metered `bigmodel-api/…` channel instead.
- **UTF-8 required** by callers; the OpenAI SDK path is fine, PowerShell 5.1's `-Body <string>` is not.
- **Latency**: 14–20 s for a short reply, ~100 s for a fan-out batch. `toolCallTimeoutMs` should be
  generous.
- **The client is an agent, not a bare model**: with a project open, a prompt may edit files. Keep
  its workspace empty while using this as a model channel.
- **Quota accounting is not exposed per call** — `usage` is reported as zero. Read the panel, or the
  client's own usage page.

## Fan-out: making a small model do volume work

`GLM-5.3-Flash` handles batches badly in one pass. The client supports subagents natively (the
primary agent launches them through its `Agent` tool), so this repo ships three skills and a role:

- `skills/dsh-handoff` — the handoff contract for mechanical work
- `skills/dsh-grunt-batch` — the machine-readable report format (ASCII labels, never translated)
- `skills/dsh-fanout` — split into 5–15 item chunks, launch one subagent per chunk **in one
  message**, merge the reports, re-run only failed chunks
- `zcode_install_agent` installs `dsh-batch-worker`, the narrow role those chunks are given

Measured run: 12 files, the primary agent reported splitting into 2 chunks and starting two workers
in parallel; each worker's report landed in
`~/.zcode/cli/agents/sess_<session>/agent_<id>/output.txt`; all 12 files were changed in 1 m 50 s.

Looping needs no external driver either: the client has `CronCreate` / `Monitor` / `ScheduleWakeup`
tools, an Automations page for scheduled tasks, and an **Idle-time task** queue that runs when spare
capacity is available (that one is free — it does not spend the grant).

## Two bridge defects this repo fixed (worth knowing if you build your own)

1. **`Input.insertText` appends to whatever is in the composer.** Without clearing first, a stale
   skill reference rides along with your prompt (observed). The bridge now selects the composer
   contents before typing and verifies, character for character, that exactly the intended text
   landed before pressing Enter.
2. **"Text stopped changing" is not completion.** While subagents run, the parent transcript is
   frozen, so a DOM-stability heuristic returns half a turn. The bridge now uses two signals: the
   composer shows `停止生成` while busy, and the answer is read from the client's **own transcript**
   (`~/.zcode/cli/rollout/model-io-sess_<session>.jsonl`, the last record with
   `querySource === "main_turn"` → `response.text`) — because the client **unloads collapsed turns
   from the DOM** (a finished agentic turn had an empty body there).

The app writes its own session-title request into the same transcript (`querySource:
"session_title"`), so filtering on `main_turn` is required. Subagent transcripts live in
`model-io-sess_subagent_agent_<id>.jsonl`.

## Layout

```
bridge/zcode-bridge.mjs      OpenAI-compatible endpoint driving the GUI over CDP
lib/index.js                 plugin host half: status route + panel route (loopback only)
lib/status.js                CDP probe, credential decrypt, plan/quota, capabilities
lib/panel.js                 self-contained HTML panel (no build step, no React)
lib/provision.js             install/remove skills, subagent roles, MCP servers
mcp/server.mjs               MCP stdio server (zero dependencies, hand-rolled JSON-RPC)
skills/                      the handoff / grunt-batch / fan-out skill texts
test/verify.mjs              self-check: exports, routing, loopback guard, no token leakage
```

## Privacy

The connector reads the client's own credential file (`~/.zcode/v2/credentials.json`) to query the
plan API. That value is used as a bearer token in one request and **never** appears in a response,
a log line, or the panel — the account section reports only an identity and a token *length*. The
self-check asserts this (`status JSON does not contain the account token`,
`panel HTML does not contain the account token`).

## Self-check

```bash
node test/verify.mjs
```

It asserts the export surface, both route registrations, the loopback guard, the live status
snapshot, and — most importantly — that neither the status JSON nor the panel HTML can leak the
account token.

Two notes:

- The plugin imports `@deepseek-ai/schemastery`, so the check needs the same dependency bridge the
  install section describes. `node_modules/` is **gitignored on purpose**: a junction there points
  at absolute paths from the machine that built it.
- The check prints live account identifiers and the current quota when a ZCode app is running. Do
  not paste its raw output into a public issue.

## License

MIT — see [LICENSE](LICENSE).
