#!/usr/bin/env node
/**
 * zcode-connect MCP server (stdio, newline-delimited JSON-RPC 2.0, no dependencies).
 *
 * Exposes the ZCode Start Plan to any MCP client — DSH consumes it through
 * `@deepseek-ai/dsh-mcp-client`, which spawns this file and publishes the tools as
 * `mcp__zcode__<name>`.
 *
 *   zcode_status  plan + live balance + client capabilities (read-only, free)
 *   zcode_runs    what the client is running in the background right now: its own
 *                 subagents, recent tasks, scheduled/off-peak runs (read-only, free)
 *   zcode_ask     send one prompt through the ZCode GUI and return the reply
 *                 (this is what spends the grant; the bridge serialises calls)
 *
 * Requirements (the caller must satisfy them):
 *   · ZCode running with --remote-debugging-port=9333
 *   · bridge/zcode-bridge.mjs listening on 127.0.0.1:9444 for zcode_ask
 * `zcode_status` works without the bridge; `zcode_ask` reports exactly what is missing.
 *
 * Wire it up with:
 *   - id: mcp-zcode
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       transport: stdio
 *       serverName: zcode
 *       command: node
 *       args: ['%USERPROFILE%/.dsh/vendor-plugins/dsh-zcode-connect/mcp/server.mjs']
 *       toolCallTimeoutMs: 300000
 *       failOnStartupError: false
 */
import { collectStatus } from '../lib/status.js'
import { describeRuns } from '../lib/runs.js'
import { ensureBridge } from '../lib/bridge.js'
import { installAgent, installMcpServer, installSkill, listInstalled, removeAgent, removeMcpServer, removeSkill } from '../lib/provision.js'

const PROTOCOL_VERSION = '2025-06-18'
/** Versions this server speaks; anything else is answered with PROTOCOL_VERSION. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2024-11-05']
const BRIDGE_URL = process.env.ZCODE_BRIDGE_URL ?? 'http://127.0.0.1:9444/v1/chat/completions'
const DEBUG_PORT = Number(process.env.ZCODE_DEBUG_PORT ?? 9333)
const BRIDGE_PORT = Number(process.env.ZCODE_BRIDGE_PORT ?? 9444)

const TOOLS = [
  {
    name: 'zcode_status',
    description:
      'Read the ZCode (Z.ai) client state: account, Start Plan, live remaining quota, and which model channels the client has loaded. Read-only and free — it does not call the model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zcode_ask',
    description:
      'Send one prompt to GLM-5.3-Flash through the ZCode desktop client (this spends the Start Plan grant) and return its reply. Calls are serialised: one conversation, one input box. ZCode must be running with its debug port, and the helper bridge must be listening.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full prompt. ZCode keeps no history between calls, so include any context you need.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_install_skill',
    description:
      'Install a skill into the ZCode client (~/.zcode/skills/<name>/SKILL.md) so its agent gains that capability on the next task. Use for handing over repeatable procedures the client should follow. The description decides when the client triggers it, so write it as "Use when …".',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, [A-Za-z0-9._-], 1..64 chars.' },
        description: { type: 'string', description: 'One-sentence trigger description the client matches against.' },
        body: { type: 'string', description: 'Markdown instruction body (no frontmatter — it is added for you).' },
        force: { type: 'boolean', description: 'Overwrite an existing skill of the same name.' },
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_install_mcp',
    description:
      'Install an MCP server at the client user scope (~/.zcode/cli/config.json → mcp.servers), which ZCode auto-connects at session start. Accepts stdio (command/args/env) or http (url/headers). Absolute paths only — the client expands template variables for plugin-provided servers only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Server name; the client exposes its tools as mcp__<name>__<tool>.' },
        command: { type: 'string', description: 'stdio: executable to spawn.' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio: arguments.' },
        cwd: { type: 'string', description: 'stdio: working directory.' },
        env: { type: 'object', description: 'stdio: environment variables (values must be strings).' },
        url: { type: 'string', description: 'http/sse: endpoint URL (mutually exclusive with command).' },
        headers: { type: 'object', description: 'http: request headers.' },
        timeoutMs: { type: 'number', description: 'Per-call timeout; the client default is 30000.' },
        force: { type: 'boolean', description: 'Replace an existing server of the same name.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_install_agent',
    description:
      'Install a user-level subagent (custom role) into ZCode (~/.zcode/agents/<name>.md), the same thing the client authors under Settings → Subagents. The primary agent then launches it through the Agent tool, in parallel with others. Use this to give the low-cost model a narrow, repeatable role instead of one oversized instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Role name, [A-Za-z0-9._-], 1..64 chars.' },
        description: { type: 'string', description: 'When the primary agent should delegate to this role.' },
        body: { type: 'string', description: 'System prompt for the role (no frontmatter — added for you).' },
        tools: { type: 'string', description: 'Comma-separated tool allow-list, e.g. "Read, Write, Edit, Glob, Grep, Bash".' },
        model: { type: 'string', description: 'Optional model override for this role (e.g. "inherit").' },
        force: { type: 'boolean', description: 'Overwrite an existing role of the same name.' },
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_runs',
    description:
      'List what the ZCode client is running in the background — its own subagents, recent tasks, and scheduled/off-peak runs — plus whether it is generating right now. Read-only and free: it reads the client state files the DSH sidebar cannot see. Use it to watch a handoff instead of polling the GUI.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum subagent runs to list (default 15).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'zcode_capabilities',
    description: 'List what this connector has installed on the ZCode client: skills and user-scope MCP servers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zcode_uninstall',
    description: 'Remove a skill or MCP server previously installed by this connector.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'mcp'], description: 'What to remove.' },
        name: { type: 'string', description: 'Installed name.' },
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
  },
]

/**
 * Compose the background-run digest: what the client is doing now, and what it just did.
 * One line per run keeps this readable for a model instead of dumping the whole snapshot.
 */
function summarizeRuns(runs) {
  const live = runs.live ?? {}
  const current = live.current ?? null
  const lines = []

  lines.push(
    live.generating
      ? `client: generating right now (${live.openRequests} open request(s)${current?.waitingMs ? `, waiting ${Math.round(current.waitingMs / 1000)}s` : ''})`
      : live.busy
        ? 'client: active a moment ago'
        : 'client: idle',
  )
  if (current) {
    lines.push(
      `current: ${current.agentType ? `subagent ${current.agentType}` : `session ${current.sessionId}`}` +
        `${current.phase ? ` · phase ${current.phase}` : ''}${current.tool ? ` · last tool ${current.tool}` : ''}` +
        `${current.quietForMs !== null ? ` · quiet ${Math.round(current.quietForMs / 1000)}s` : ''}`,
    )
  }

  const agents = runs.agents ?? []
  const running = agents.filter((agent) => agent.running)
  const finished = agents.filter((agent) => !agent.running && !agent.stale)

  lines.push(`subagents: ${running.length} running, ${finished.length} finished recorded (${runs.counts?.tokens ?? 0} tokens, ${runs.counts?.toolUses ?? 0} tool calls total)`)
  for (const agent of running) {
    const waiting = agent.generating ? 'generating' : 'working'
    lines.push(
      `  RUNNING ${agent.role ?? 'subagent'} — ${agent.description ?? '(no description)'} · ${waiting}` +
        `${agent.activity?.lastTool ? ` · tool ${agent.activity.lastTool}` : ''}` +
        `${agent.activity?.turns ? ` · turn ${agent.activity.turns}` : ''}` +
        ` · elapsed ${Math.round((agent.durationMs ?? 0) / 1000)}s · ${agent.tokens ?? 0} tokens`,
    )
  }
  for (const agent of finished.slice(0, 12)) {
    const counts = agent.counts ? Object.entries(agent.counts).filter(([, value]) => value > 0).map(([key, value]) => `${key}=${value}`).join(' ') : ''
    lines.push(
      `  DONE    ${agent.role ?? 'subagent'} — ${agent.description ?? '(no description)'} · ${agent.outcome ?? agent.status}` +
        ` · ${Math.round((agent.durationMs ?? 0) / 1000)}s · ${agent.tokens ?? 0} tokens · ${agent.toolUses ?? 0} tools` +
        `${counts ? ` · ${counts}` : ''}`,
    )
    for (const item of (agent.items ?? []).slice(0, 4)) lines.push(`            ${item.kind}: ${item.path}`)
  }
  for (const agent of agents.filter((entry) => entry.stale)) {
    lines.push(`  STALLED ${agent.role ?? 'subagent'} — ${agent.description ?? '(no description)'} · no completion stamp, quiet ${Math.round((agent.quietForMs ?? 0) / 1000)}s`)
  }

  const tasks = (runs.tasks ?? []).filter((task) => task.open || task.live || task.agents > 0).slice(0, 8)
  if (tasks.length > 0) {
    lines.push('tasks:')
    for (const task of tasks) {
      lines.push(`  ${task.open || task.live ? 'RUNNING' : 'done   '} ${(task.title ?? task.taskId).slice(0, 80)} · ${task.agents} subagent(s)`)
    }
  }

  const scheduled = runs.automations?.scheduled ?? []
  const offPeak = runs.automations?.offPeak ?? []
  if (scheduled.length > 0 || offPeak.length > 0) {
    lines.push(`scheduled runs: ${scheduled.length} automation(s), ${offPeak.length} off-peak task(s)`)
    for (const item of scheduled.slice(0, 5)) lines.push(`  ${item.enabled ? 'on ' : 'off'} ${item.title ?? item.id} · ${item.cron ?? '?'} · next ${item.nextRunAt ?? '?'}`)
    for (const item of offPeak.slice(0, 5)) lines.push(`  off-peak ${item.title ?? item.id} · ${item.status ?? '?'}`)
  }

  if (runs.notes?.length) lines.push(`notes: ${runs.notes.join(' · ')}`)
  return lines.join('\n')
}

/** Compose a compact, human-readable summary for the model. */
function summarize(status) {
  const balance = status.grant?.balances?.[0] ?? null
  const plan = status.grant?.plans?.[0] ?? null
  const channels = status.capabilities?.channels ?? []
  const lines = [
    `account: ${status.account ? `${status.account.displayName ?? '?'} (${status.account.id ?? '?'})` : 'unreadable'}`,
    `client: ${status.cdp?.reachable ? `running, v${status.cdp.appVersion ?? '?'}, CDP ${status.cdp.browser ?? '?'}` : `NOT reachable (${status.cdp?.reason ?? 'unknown'})`}`,
    `bridge: ${status.bridge?.reachable ? `available, inflight ${status.bridge.inflight ?? 0}` : 'NOT running on 127.0.0.1:' + BRIDGE_PORT}`,
    plan ? `plan: ${plan.name ?? plan.planId} (${plan.status ?? '?'}) ends ${balance?.expiresAt ? new Date(balance.expiresAt * 1000).toLocaleString() : '?'}` : 'plan: none reported',
    balance
      ? `balance: ${balance.availableUnits ?? balance.remainingUnits ?? '?'} of ${balance.totalUnits ?? '?'} ${balance.unitType ?? ''} available, used ${balance.usedUnits ?? '?'} (source: ${status.grant?.balancesSource ?? '?'})`
      : 'balance: unavailable',
    `channels: ${channels.filter((channel) => channel.enabled).map((channel) => channel.key).join(', ') || 'none enabled'} (of ${channels.length} configured)`,
  ]
  if (status.grant?.errors?.length) lines.push(`plan errors: ${status.grant.errors.join(' · ')}`)
  if (status.notes?.length) lines.push(`notes: ${status.notes.join(' · ')}`)
  return lines.join('\n')
}

async function callTool(name, args) {
  if (name === 'zcode_status') {
    const status = await collectStatus({ debugPort: DEBUG_PORT, bridgePort: BRIDGE_PORT })
    return { text: summarize(status), structured: status }
  }

  if (name === 'zcode_runs') {
    const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 15
    const runs = await describeRuns(undefined, { limit })
    return { text: summarizeRuns(runs), structured: runs }
  }

  if (name === 'zcode_ask') {
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) throw new Error('zcode_ask requires a non-empty "prompt" string')

    // On-demand bridge: nothing starts the GUI bridge at boot (the plugin's default mode), so the
    // first call that actually needs it starts it. `ZCODE_BRIDGE_MODE`/`ZCODE_BRIDGE_SCRIPT` come
    // from the environment when the profile wires this server up.
    const bridgeMode = process.env.ZCODE_BRIDGE_MODE ?? 'on-demand'
    if (bridgeMode !== 'off') {
      const ensured = await ensureBridge({
        port: BRIDGE_PORT,
        script: process.env.ZCODE_BRIDGE_SCRIPT,
        mode: 'on-demand',
      })
      if (!ensured.reachable) {
        throw new Error(
          `the ZCode GUI bridge is not answering on 127.0.0.1:${BRIDGE_PORT} and could not be started ` +
            `(${ensured.error ?? 'unknown reason'}). Start it with: node <plugin>/bridge/zcode-bridge.mjs ` +
            `— and make sure ZCode runs with --remote-debugging-port=${DEBUG_PORT}.`,
        )
      }
    }

    let response
    try {
      response = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'zcode/GLM-5.3-Flash', messages: [{ role: 'user', content: prompt }] }),
      })
    } catch (error) {
      throw new Error(
        `cannot reach the ZCode bridge at ${BRIDGE_URL} (${error.message}). ` +
          `Start it with: node <plugin>/bridge/zcode-bridge.mjs — and make sure ZCode runs with --remote-debugging-port=${DEBUG_PORT}.`,
      )
    }
    const text = await response.text()
    if (!response.ok) {
      let detail = text.slice(0, 300)
      try {
        detail = JSON.parse(text).error?.message ?? detail
      } catch {
        /* keep the raw slice */
      }
      throw new Error(`bridge refused the request (HTTP ${response.status}): ${detail}`)
    }
    const parsed = JSON.parse(text)
    const reply = parsed.choices?.[0]?.message?.content ?? ''
    if (!reply) throw new Error('bridge returned an empty reply')
    return { text: reply, structured: { reply, model: parsed.model ?? null } }
  }

  if (name === 'zcode_install_skill') {
    const outcome = installSkill({
      name: args?.name,
      description: args?.description,
      body: args?.body,
      force: args?.force === true,
    })
    return { text: `installed skill "${outcome.name}" at ${outcome.path} (${outcome.bytes} bytes). It becomes available to the client's agent on the next task.`, structured: outcome }
  }

  if (name === 'zcode_install_mcp') {
    const outcome = installMcpServer({
      name: args?.name,
      server: {
        command: args?.command,
        args: args?.args,
        cwd: args?.cwd,
        env: args?.env,
        url: args?.url,
        headers: args?.headers,
        timeoutMs: args?.timeoutMs,
      },
      force: args?.force === true,
    })
    return {
      text:
        `installed MCP server "${outcome.name}" (${outcome.server.type}) in ${outcome.path} — ` +
        `${outcome.totalServers} user-scope server(s) now configured. The client auto-connects it at the next session and exposes its tools as mcp__${outcome.name}__*.`,
      structured: outcome,
    }
  }

  if (name === 'zcode_install_agent') {
    const outcome = installAgent({
      name: args?.name,
      description: args?.description,
      body: args?.body,
      tools: args?.tools,
      model: args?.model,
      force: args?.force === true,
    })
    return { text: `installed subagent "${outcome.name}" at ${outcome.path} (${outcome.bytes} bytes). The client's primary agent can now delegate to it through the Agent tool.`, structured: outcome }
  }

  if (name === 'zcode_capabilities') {
    const installed = listInstalled()
    const lines = [
      `skills (${installed.skills.length}) at ${installed.roots.skills}:`,
      ...installed.skills.map((skill) => `  ${skill.name} — ${skill.description ?? '(no description)'}`),
      `subagents (${installed.agents.length}) at ${installed.roots.agents}:`,
      ...installed.agents.map((agent) => `  ${agent.name}${agent.tools ? ` [${agent.tools}]` : ''} — ${agent.description ?? '(no description)'}`),
      `user-scope MCP servers (${installed.mcpServers.length}) in ${installed.roots.userConfig}:`,
      ...installed.mcpServers.map((server) => `  ${server.name} [${server.type}] ${server.enabled ? 'enabled' : 'disabled'} → ${server.target}`),
    ]
    return { text: lines.join('\n'), structured: installed }
  }

  if (name === 'zcode_uninstall') {
    const kind = args?.kind
    if (kind === 'skill') {
      const outcome = removeSkill(args?.name)
      return { text: outcome.removed ? `removed skill "${outcome.name}"` : `skill "${outcome.name}" was not installed`, structured: outcome }
    }
    if (kind === 'agent') {
      const outcome = removeAgent(args?.name)
      return { text: outcome.removed ? `removed subagent "${outcome.name}"` : `subagent "${outcome.name}" was not installed`, structured: outcome }
    }
    if (kind === 'mcp') {
      const outcome = removeMcpServer(args?.name)
      return { text: outcome.removed ? `removed MCP server "${outcome.name}"` : `MCP server "${outcome.name}" was not installed`, structured: outcome }
    }
    throw new Error('zcode_uninstall requires kind: "skill" | "agent" | "mcp"')
  }

  throw new Error(`unknown tool: ${name}`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(request) {
  const { id, method, params } = request
  try {
    if (method === 'initialize') {
      // Reply with a version this server actually implements. Echoing whatever the client asked
      // for would "accept" a version we do not speak (measured: asked 2024-11-05, echoed back).
      const requested = params?.protocolVersion
      const agreed = SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_VERSION
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: agreed,
          capabilities: { tools: {} },
          serverInfo: { name: 'zcode-connect', version: '0.1.0' },
        },
      })
      return
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    }
    if (method === 'tools/call') {
      const toolName = params?.name
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        // An unknown tool is a request error, not a tool result: -32602 Invalid params.
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(toolName)}` } })
        return
      }
      const outcome = await callTool(toolName, params?.arguments)
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: outcome.text }],
          ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
          isError: false,
        },
      })
      return
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    // Notifications carry no id and expect no reply.
    if (id === undefined) return
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (error) {
    if (id === undefined) return
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${error.message}` }], isError: true } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) {
      try {
        const request = JSON.parse(line)
        void handle(request)
      } catch (error) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${error.message}` } })
      }
    }
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
