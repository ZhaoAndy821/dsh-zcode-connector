# DSH ZCode Connector

Use the **ZCode (Z.ai) desktop app** as a model channel from **DeepSeek Harness (DSH)** — by
driving the app's own GUI over Chrome DevTools Protocol, not by pretending it is an API key.

It ships three things:

| Piece | What it does |
|---|---|
| `bridge/zcode-bridge.mjs` | Local OpenAI-compatible endpoint (`POST /v1/chat/completions`) that types a prompt into the running ZCode window, waits for the turn to finish, and returns the answer; the plugin ships this same file and starts it on demand |
| plugin `dsh-zcode-connect` | Host half with three loopback routes (status JSON, the HTML panel, and an on-demand bridge start) plus a client half that puts the panel in DSH's right sidebar as a tab — account, plan, live quota, loaded capabilities, what this connector installed, and what the client is running in the background right now |
| `mcp/server.mjs` | MCP stdio server exposing status, background runs, ask, and provisioning tools to any MCP client (DSH consumes it through `@deepseek-ai/dsh-mcp-client`) |

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

So the way to reach that quota from your own tooling is to **let the first-party client make the
call** and drive its UI. That is what this project does — and it is the reason the grant is
reachable here at all.

## The client does the real work

- **The client signs every request.** ZCode's own renderer mints the per-request attestation, so the
  call path is the same one the app uses when you press Send by hand.
- **Same widgets, same events, same channels.** The bridge attaches over the public Chromium
  DevTools Protocol and drives the real controls — nothing internal is reimplemented, and no hidden
  endpoint is called behind the app's back.
- **The credential is read-only, and only for display.** The account token is used for exactly one
  thing: asking the client's own plan API how much of the grant is left, so the panel can show it.
  It never leaves in a response, never reaches a log, and the self-check asserts that.
- **One account, one session, one conversation at a time.** The bridge is serialised by design: no
  parallel-call path, no retry storming.
- **The client stays the vendor's build.** No proxy, no certificate injection, no patched binary.
- **The prompt is verified before it is sent.** The composer is cleared first and the text is checked
  character-for-character, so what arrives is exactly what the caller wrote.
- **Answers are read from the client's own transcript**, not scraped from a screen — so long,
  tool-heavy turns come back complete.

## It behaves exactly like a normal user

**The window does not have to be visible, focused, on top, or even restored.** Input goes to the
renderer over CDP, which is independent of window stacking and of OS focus, so ZCode can sit
minimised behind your other work — it just has to be running. (Measured: the app was launched
minimised and every click and keystroke below still landed.)

**Window position and size are not part of the contract.** Two different things are easy to confuse
here, so the connector keeps them apart:

| | What it is | Does the bridge touch it? |
|---|---|---|
| the window | the OS window you open from the dock or taskbar — a display surface | **no**: never read, never moved, never resized |
| the renderer page | the Chromium page inside that window (`file://…/renderer/index.html`) — the only CDP target the bridge attaches to | only its *layout viewport*, and only for the duration of one request |

There is exactly one page target and it is the renderer of the very window you use; no second, hidden
window is opened. The status/panel half touches no window at all — it reads files.

The page's viewport is frozen for the length of a request because a turn can run for minutes: a
target's centre is measured and then clicked, and if the window were resized in between, the target
would have moved. The freeze uses the size the window **already has**, plus its device pixel ratio, so
nothing you see changes, and it is released the moment the request ends. Verified: with the fallback
deliberately set to 1000×700 the bridge logs `viewport frozen at 1280x900 @1.5x (source: window)`, and
an override placed before a call is gone after it — the page returns to its own 1280×900 at dpr 1.5.

The app lays out against the viewport it is told it has, anchoring its composer 73 px above the bottom
edge (measured at 1244×802, 1100×650 and 1280×900). Announcing a size *larger* than the window is
therefore what pushes the composer off the bottom of the window — which is why the bridge announces the
window's own size; `ZCODE_VIEWPORT_W` / `ZCODE_VIEWPORT_H` are only a fallback for a window reporting
no usable size (below 640×480).

Apart from that, nothing is unusual: the same widgets, the same events, the same request path.

| A person does | The bridge does |
|---|---|
| clicks **New task** in the sidebar | dispatches a real mouse click at that element's centre (`Input.dispatchMouseEvent`) |
| clicks the model selector, picks the plan channel | same, after reading the composer's label and verifying the hit landed on the intended element |
| types the prompt into the composer | focuses it, replaces the selection, sends `Input.insertText`, then verifies the text landed character-for-character |
| presses **Enter** | `Input.dispatchKeyEvent` with the Enter keycode |
| reads the answer | reads the client's own transcript (`querySource === "main_turn"`) — the same record the app writes for its own history |

There is no hidden channel and no injected business logic: the automation layer only clicks, types,
and reads what the client already displays or persists.

## Watching what the client runs in the background

When ZCode works, it works **inside its own process**: the primary agent spawns subagents, runs tool
calls, and keeps going on its own. Nothing about that reaches the harness that asked for it — DSH's
own sidebar lists DSH's subagents and jobs, and it cannot see the ones running in another
application. The connector therefore reads the client's own state files and renders them into its
panel (and over MCP), so the run is visible while it happens:

| Shown | Meaning |
|---|---|
| running subagents | role, the task it was given, the tool it is executing **right now** (with its target path), elapsed time, turns, tool calls, tokens |
| finished subagents | outcome (`done` / `partial` / `blocked`), duration, tokens, tool count, the `CHANGED:` / `FAILED:` item list from its own report |
| recent tasks | the client's task list with per-task subagent count, total tokens, and last activity |
| generating indicator | whether inference is open right now, and for how long |
| scheduled work | Automations, their runs, and idle-time (off-peak) tasks |

It is passive: three reads of files the client already writes, no injection, no polling of the GUI,
no extra quota.

| Source | What it yields |
|---|---|
| `~/.zcode/cli/agents/sess_*/agent_*/metadata.json` | one directory per subagent run: role, task, status, tokens, tool count, duration |
| `~/.zcode/cli/agents/sess_*/agent_*/output.txt` | the worker's own report, parsed into outcome + counts + item list |
| `~/.zcode/cli/rollout/model-io-*.jsonl` | one record per model round trip, appended as the run proceeds (live turn count) |
| `~/.zcode/cli/log/zcode-<date>.jsonl` | the client's turn lifecycle: open inference requests, every tool call, per-session phases |
| `~/.zcode/v2/tasks-index.sqlite` | task titles, per-task status, Automations and off-peak runs |

The same view is available to an agent as the `zcode_runs` MCP tool, which is the practical way to
watch a long handoff: a single call reports what is running, what it is doing, and what finished.
The panel refreshes every 15 s while it is open.

This is also what makes long runs safe to hand over. A thinking-heavy turn can outlast a caller's own
wait budget — the call returns a timeout, the client keeps working — and the run stays observable
instead of being lost with the call.

## Where it appears: a tab in the right sidebar

The panel is not a page you have to go and open. The plugin ships a **client half** that registers it
as a tab next to Subagents and Tasks in DSH's right sidebar, and Settings → Plugins → ZCode carries
the switch that adds or removes it (a per-browser preference, on by default).

Three extension points make that tab, all of them DSH's own:

| What | Registered into | Notes |
|---|---|---|
| the tab type | `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` | a `kind` of its own, so it cannot collide with Files/Tasks; the `guide` capsule is how it shows up in the sidebar's list |
| its body | slot `sidebar.right.pane.tab`, keyed by that id | an `iframe` of the host route below, so the view has one implementation, not two |
| its chip title | slot `sidebar.right.pane.tab.title`, keyed by the same id | glyph + the title the frame hands in |

The same shape works for any DSH plugin that wants a right-sidebar panel; `lib/client.js` is a
prebuilt bundle (no bundler — it is already in the `__ModuleLoader__.load` envelope).

## Extensibility: turn ZCode into a grunt-work executor

ZCode is an extension platform in its own right, and this connector exposes that surface over MCP,
so a caller can reshape the client instead of merely talking to it:

| ZCode extension point | Where it lives | Installed by |
|---|---|---|
| Skills | `~/.zcode/skills/<name>/SKILL.md` | `zcode_install_skill` |
| Custom subagents (roles) | `~/.zcode/agents/<name>.md` | `zcode_install_agent` |
| MCP servers | `~/.zcode/cli/config.json` → `mcp.servers` | `zcode_install_mcp` |
| Plugins & marketplaces | the client's own plugin system | the client UI |
| Automations, idle-time tasks, cron tools | the client's scheduling surface | the client, or a prompt |

That composition is what makes it useful for tedious volume rather than reasoning: **skills** teach
the contract (what to return, in what format), **subagent roles** narrow a small model's job so it
cannot wander, **fan-out** splits a batch into chunks the model can actually finish, **MCP servers**
hand it tools it did not have, and **automations** keep it working on a cadence without a driver.

Measured example: 12 files, primary agent split into two chunks and ran two `dsh-batch-worker`
subagents in parallel, each returning a machine-readable `CHANGED:` report — 1 m 50 s end to end.

None of this is ZCode-specific plumbing. The same shape — attach over CDP, install skills and
subagent roles, expose the lot over MCP — applies to any Electron client that has its own extension
points, which is why the pattern is worth publishing as a template rather than a one-off script.

## Requirements

- ZCode desktop, launched with a debug port: `ZCode.exe --remote-debugging-port=9333`
  (it must be **running**, but it does not need to be visible or in the foreground — minimised,
  covered, or on another virtual desktop all work; only closing it breaks the bridge)
- Node.js 20+ (the bridge and MCP server use the built-in `fetch`)
- DeepSeek Harness, if you want the plugin half

## Install

### 1. The bridge (shipped here; the plugin can start it for you)

```bash
node bridge/zcode-bridge.mjs           # listens on 127.0.0.1:9444
```

`POST /v1/chat/completions` (OpenAI-shaped, non-streaming). `GET /healthz` reports the queue depth.

The plugin ships its own copy of that file and owns the process, so you do not have to start it by
hand. `bridgeMode` decides who does:

| `bridgeMode` | Who starts it |
|---|---|
| `on-demand` (**default**) | nobody at boot — the first thing that needs it does: an MCP `zcode_ask`, or the panel's 「start the bridge」 button |
| `auto` | the plugin starts it while loading and stops it again when it unloads |
| `off` | the plugin never touches the process; it only reports whether the port answers |

`bridgeScript` overrides which file gets spawned; empty means the copy bundled with the plugin.

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
    debugPort: 9333          # ZCode's --remote-debugging-port
    bridgePort: 9444         # the bridge above
    bridgeMode: on-demand    # on-demand | auto | off — see the table above
```

> **The client half is fail-closed — do not half-declare it.** `package.json` declares
> `exports["./client"]` and `dsh.client`, and `lib/client.js` must therefore exist. DSH composes
> client bundles at startup and *refuses to boot* when a declaration resolves to no file
> (`ClientPackageCompositionError`; observed as the launcher bringing `dsh` up and it exiting a few
> seconds later). Shipping both together is the only valid state; if you ever remove
> `lib/client.js`, remove those two declarations in the same commit.

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
| `zcode_runs` | what the client is running in the background right now, plus what it just finished | no |
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

## Operating requirements (all measured)

- **The client must be running** with the debug port. It does **not** need to be in the foreground:
  minimised, behind other windows, or unfocused all work, because events are delivered to the
  renderer rather than to the OS window.
- **Window geometry is free.** The OS window is never read, moved or resized; the bridge attaches to the
  renderer page inside it. For the duration of one request the page's layout viewport is frozen at the
  window's *current* size (and device pixel ratio) so a target cannot drift between being measured and
  being clicked, and it is released when the request ends — a per-request freeze, not a resize of your
  window.
- **Serial**: one conversation, one input box. The bridge queues; it does not parallelise.
- **The bridge is a separate process, and this plugin owns it.** `bridgeMode` decides whether it is
  started on demand (default), at load, or never; a bridge that was already running is reused, and one
  this plugin did not start is never stopped.
- **One new task per call** — the client keeps no history between calls, so send full context.
- **Channel must be `Start Plan`.** The bridge checks the composer's model label every call and
  switches it if it reads the metered `bigmodel-api/…` channel instead.
- **UTF-8 required** by callers; the OpenAI SDK path is fine, PowerShell 5.1's `-Body <string>` is not.
- **Latency**: 14–20 s for a short reply, ~100 s for a fan-out batch. `toolCallTimeoutMs` should be
  generous. A turn spent thinking at the highest level can exceed any fixed budget while the client
  keeps working — `zcode_runs` (or the panel) shows that run continuing.
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

## Layout

```
bridge/zcode-bridge.mjs      OpenAI-compatible endpoint driving the GUI over CDP
lib/index.js                 plugin host half: status + panel + bridge-start routes (loopback only)
lib/status.js                CDP probe, credential decrypt, plan/quota, capabilities
lib/runs.js                  background runs: subagents, client log activity, task index
lib/bridge.js                bridge lifecycle: probe / start on demand / own the process
lib/client.js                client half: registers the right-sidebar tab + the settings card
lib/panel.js                 self-contained HTML panel (no build step, no React)
lib/provision.js             install/remove skills, subagent roles, MCP servers
mcp/server.mjs               MCP stdio server (zero dependencies, hand-rolled JSON-RPC)
skills/                      the handoff / grunt-batch / fan-out skill texts
test/verify.mjs              self-check: exports, routing, loopback guard, run parsing, token leakage
test/client-bundle.mjs       self-check: the client half's slot contract and its switch
```

## Privacy

The connector reads the client's own credential file (`~/.zcode/v2/credentials.json`) to query the
plan API. That value is used as a bearer token in one request and **never** appears in a response,
a log line, or the panel — the account section reports only an identity and a token *length*. The
self-check asserts this (`status JSON does not contain the account token`,
`panel HTML does not contain the account token`).

The background-run view follows the same rule: it reports a run's role, status, timings, counts,
changed paths and its own report — not the prompt it was given and not its system prompt. The
self-check asserts that too (`no prompt text leaks into the snapshot`).

## Self-check

```bash
node test/verify.mjs          # host half
node test/client-bundle.mjs   # client half
```

`verify.mjs` asserts the export surface, the three route registrations, the loopback guard, the live
status snapshot, the background-run view against a synthetic client home (a run without a completion
stamp must read as running, an open inference request must read as generating, a finished run must
carry its own report), the bridge lifecycle against a real process it starts and stops itself, and —
most importantly — that neither the status JSON nor the panel HTML can leak the account token.

`client-bundle.mjs` runs `lib/client.js` the way the client does (`window.__ModuleLoader__.load`) and
asserts the tab contract: a tab type in `sidebarRightTabs`, a body and a chip title keyed by the same
id, a settings card under this plugin's namespace, and a switch that adds and removes all three.

The plugin imports `@deepseek-ai/schemastery`, so the checks use the same dependency bridge the
install section describes.

## License

MIT — see [LICENSE](LICENSE).
