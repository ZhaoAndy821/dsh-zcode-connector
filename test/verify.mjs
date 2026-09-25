/**
 * Self-check for dsh-zcode-connect.
 *
 * Asserts the export surface, both route registrations, the loopback guard, the real
 * status snapshot (against the live ZCode app + plan API), and — most importantly —
 * that neither the JSON nor the panel HTML can leak the account token.
 *
 * Run: node test/verify.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createDecipheriv, createHash } from 'node:crypto'
import { homedir, platform, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

const host = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)

// ── 1. export surface ────────────────────────────────────────────────────────
check('named exports present', ['name', 'inject', 'Config', 'apply'].every((key) => key in host), Object.keys(host).join(','))
check('no default export', host.default === undefined)
check('plugin name is zcode-connect', host.name === 'zcode-connect', String(host.name))
check('inject is empty (all capabilities optional)', Array.isArray(host.inject) && host.inject.length === 0, JSON.stringify(host.inject))

// ── 2. wiring with a stub context ───────────────────────────────────────────
const routes = []
const sections = []
const stub = {
  logger: { warn() {}, info() {} },
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject: (names, callback) => {
    const list = Array.isArray(names) ? names : [names]
    const child = {}
    if (list.includes('webServer')) child.webServer = { register: (spec) => { routes.push(spec); return () => {} } }
    if (list.includes('settings')) child.settings = { installSection: (...args) => { sections.push(args) } }
    if (list.every((name) => child[name] !== undefined)) callback(child)
    return () => {}
  },
}

const config = host.Config({})
host.apply(stub, config)

check('registers exactly two routes', routes.length === 2, String(routes.length))
check('status route path', routes[0]?.path === '/plugins/dsh-zcode-connect/status', String(routes[0]?.path))
check('panel route path', routes[1]?.path === '/plugins/dsh-zcode-connect/panel', String(routes[1]?.path))
check('both routes are kind=exact', routes.every((route) => route.kind === 'exact'))
check('installs one settings section', sections.length === 1, String(sections.length))
check('settings namespace matches the package', sections[0]?.[1] === 'dsh-zcode-connect', String(sections[0]?.[1]))

/** Minimal response recorder. */
function fakeResponse() {
  const captured = { status: null, headers: null, body: '' }
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(body) { captured.body = String(body ?? '') },
  }
}

// ── 3. loopback guard ───────────────────────────────────────────────────────
{
  const response = fakeResponse()
  await routes[0].handler({ method: 'GET', socket: { remoteAddress: '10.0.0.7' } }, response)
  check('status refuses a non-loopback peer', response.captured.status === 403, String(response.captured.status))
}
{
  const response = fakeResponse()
  await routes[0].handler({ method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' } }, response)
  check('status allows an IPv4-mapped loopback peer', response.captured.status === 200, String(response.captured.status))
}

// ── 4. the real snapshot ────────────────────────────────────────────────────
const statusResponse = fakeResponse()
await routes[0].handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, statusResponse)
let snapshot = null
try {
  snapshot = JSON.parse(statusResponse.captured.body)
} catch (error) {
  check('status returns JSON', false, error.message)
}
if (snapshot) {
  check('status returns JSON', true)
  check('cdp reachable (ZCode running with the debug port)', snapshot.cdp?.reachable === true, JSON.stringify(snapshot.cdp?.reason ?? ''))
  check('app version parsed from the client', typeof snapshot.cdp?.appVersion === 'string', String(snapshot.cdp?.appVersion))
  check('account identity present', Boolean(snapshot.account?.id), `${snapshot.account?.displayName ?? '?'} · ${snapshot.account?.id ?? '?'}`)
  check('grant authenticated by the account token', snapshot.grant?.authenticated === true, JSON.stringify(snapshot.grant?.errors ?? []))
  const balance = snapshot.grant?.balances?.[0]
  check('balance entry present', Boolean(balance), JSON.stringify(balance ?? {}))
  if (balance) check('balance carries a positive total', typeof balance.totalUnits === 'number' && balance.totalUnits > 0, `${balance.totalUnits} ${balance.unitType}`)
  const plan = snapshot.grant?.plans?.[0]
  check('plan entry present', Boolean(plan), JSON.stringify(plan?.planId ?? {}))
  if (plan) check('plan exposes entitlements', Array.isArray(plan.entitlements) && plan.entitlements.length > 0, `${plan.entitlements?.length ?? 0} entitlements`)
  check('balances carry a source', ['client-log', 'plan-api'].includes(snapshot.grant?.balancesSource), String(snapshot.grant?.balancesSource))
  check('no unexplained grant errors', (snapshot.grant?.errors ?? []).length === 0, JSON.stringify(snapshot.grant?.errors ?? []))
  check('capabilities read from the client config', Array.isArray(snapshot.capabilities?.channels) && snapshot.capabilities.channels.length > 0, `${snapshot.capabilities?.channels?.length ?? 0} channels`)
  check('installed view present (skills + MCP)', Array.isArray(snapshot.installed?.skills) && Array.isArray(snapshot.installed?.mcpServers), `${snapshot.installed?.skills?.length ?? 0} skills, ${snapshot.installed?.mcpServers?.length ?? 0} mcp`)
  check('background runs view present', snapshot.runs !== null && Array.isArray(snapshot.runs?.agents), `${snapshot.runs?.agents?.length ?? 0} subagent runs`)
  check('runs view carries a live section', snapshot.runs?.live !== null && typeof snapshot.runs?.live?.busy === 'boolean', JSON.stringify(snapshot.runs?.live?.openRequests ?? null))
  check('runs view reports its sources', Boolean(snapshot.runs?.roots?.agents && snapshot.runs?.roots?.rollout), JSON.stringify(snapshot.runs?.roots ?? {}))
  check('runs view reads the client task index', snapshot.runs?.indexAvailable === true && Array.isArray(snapshot.runs?.tasks), `${snapshot.runs?.tasks?.length ?? 0} tasks`)
  check('runs view reads the client log', snapshot.runs?.activityAvailable === true, String(snapshot.runs?.activityAvailable))
  check('recorded runs carry a role and a status', (snapshot.runs?.agents ?? []).every((run) => typeof run.role === 'string' && typeof run.status === 'string'))
  check('recorded runs carry a per-run report summary', (snapshot.runs?.agents ?? []).some((run) => run.counts !== null || run.outcome !== null), `${(snapshot.runs?.agents ?? []).filter((run) => run.hasReport).length} with a report`)
}

// ── 5. no token anywhere ────────────────────────────────────────────────────
{
  const PREFIX = 'enc:v1:'
  const secret = process.env.ZCODE_CREDENTIAL_SECRET
    ?? `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`
  const store = JSON.parse(readFileSync(join(homedir(), '.zcode', 'v2', 'credentials.json'), 'utf8'))
  const raw = store.zcodejwttoken
  const parts = raw.slice(PREFIX.length).split('.')
  const key = createHash('sha256').update(secret).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'))
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'))
  const token = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8')

  check('status JSON does not contain the account token', !statusResponse.captured.body.includes(token))
  check('status JSON carries no enc:v1 envelope', !statusResponse.captured.body.includes(PREFIX))
  check('status JSON carries no subagent prompt text', !/"prompt"/.test(statusResponse.captured.body) && !/"systemPrompt"/.test(statusResponse.captured.body))

  const panelResponse = fakeResponse()
  routes[1].handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, panelResponse)
  check('panel renders HTML', panelResponse.captured.status === 200 && panelResponse.captured.body.startsWith('<!doctype html'), String(panelResponse.captured.status))
  check('panel embeds the status route', panelResponse.captured.body.includes('/plugins/dsh-zcode-connect/status'))
  check('panel HTML does not contain the account token', !panelResponse.captured.body.includes(token))
  check('panel has no API-key input (not a provider card)', !/<input[^>]+type=["']?password/i.test(panelResponse.captured.body) && !/api[_-]?key/i.test(panelResponse.captured.body.replace(/API key/g, '')), '')
  check('panel has the background-run section', panelResponse.captured.body.includes('ZCode 后台') && panelResponse.captured.body.includes('subagent'))
  check('panel has the scheduled-run section', panelResponse.captured.body.includes('定时与空闲任务'))
  check('panel escapes client-sourced text', panelResponse.captured.body.includes('const esc ='))
  check('panel draws a live indicator', panelResponse.captured.body.includes('live-dot') && panelResponse.captured.body.includes('renderRuns'))
  check('panel refreshes faster than the old 30 s', /setInterval\(load,\s*15000\)/.test(panelResponse.captured.body))
}

// ── 6. background runs: a synthetic client home ─────────────────────────────
// The live machine is whatever it happens to be; this fixture pins the parsing contract:
// an unfinished run must read as running, a finished one must carry its own report, and an
// open inference request in the client log must read as "generating right now".
{
  const runsModule = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'runs.js')).href)
  const fixture = mkdtempSync(join(tmpdir(), 'zcode-runs-'))
  const day = new Date()
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const write = (relative, body) => {
    const path = join(fixture, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body, 'utf8')
    return path
  }

  const runningAgentId = 'agent_run-runnning'
  const doneAgentId = 'agent_run-done'
  write(`cli/agents/sess_parent-1/${runningAgentId}/metadata.json`, JSON.stringify({
    agentId: runningAgentId,
    childSessionId: `sess_subagent_${runningAgentId}`,
    parentSessionId: 'sess_parent-1',
    profileId: 'dsh-batch-worker',
    profileSnapshot: { name: 'dsh-batch-worker', description: 'batch worker', tools: ['Read', 'Edit'] },
    description: 'half-finished batch',
    prompt: 'PROMPT-MUST-NOT-APPEAR',
    createdAt: new Date().toISOString(),
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    totalTokens: 111,
    totalToolUseCount: 2,
  }))
  write(`cli/agents/sess_parent-1/${doneAgentId}/metadata.json`, JSON.stringify({
    agentId: doneAgentId,
    childSessionId: `sess_subagent_${doneAgentId}`,
    parentSessionId: 'sess_parent-1',
    profileSnapshot: { name: 'dsh-batch-worker', description: 'batch worker' },
    description: 'finished batch',
    prompt: 'PROMPT-MUST-NOT-APPEAR',
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    completedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    status: 'completed',
    totalDurationMs: 30_000,
    totalTokens: 222,
    totalToolUseCount: 3,
    outputFile: join(fixture, 'cli', 'agents', 'sess_parent-1', doneAgentId, 'output.txt'),
  }))
  write(`cli/agents/sess_parent-1/${doneAgentId}/output.txt`, [
    'outcome: done',
    'counts: processed=2 changed=2 created=0 skipped=0 failed=0',
    'CHANGED: D:/tmp/fixture/a.txt',
    'CHANGED: D:/tmp/fixture/b.txt',
    '',
  ].join('\n'))
  const transcript = (sessionId, toolName, turns) => write(
    `cli/rollout/model-io-${sessionId}.jsonl`,
    Array.from({ length: turns }, (_, index) => JSON.stringify({
      querySource: sessionId.includes('subagent') ? 'subagent' : 'main_turn',
      completedAt: new Date(Date.now() - (turns - index) * 5000).toISOString(),
      model: { modelId: 'GLM-5.3-Flash', providerId: 'account:bigmodel-start-plan' },
      response: { text: `answer ${index}`, toolCalls: [{ name: toolName, input: { file_path: 'D:/tmp/fixture/a.txt' } }], usage: { totalTokens: 10 } },
    })).join('\n') + '\n',
  )
  transcript(`sess_subagent_${runningAgentId}`, 'Edit', 2)
  transcript('sess_parent-1', 'Agent', 1)
  write(`cli/log/zcode-${stamp}.jsonl`, [
    JSON.stringify({ timestamp: new Date(Date.now() - 20_000).toISOString(), event: 'turn.phase.started', module: 'core.runtime', sessionId: `sess_subagent_${runningAgentId}`, context: JSON.stringify({ phase: 'regular_turn_loop', turnNumber: 0 }) }),
    JSON.stringify({ timestamp: new Date(Date.now() - 4000).toISOString(), event: 'tool.call.started', module: 'core.tool.executor', sessionId: `sess_subagent_${runningAgentId}`, context: JSON.stringify({ toolName: 'Edit', agentId: runningAgentId, agentType: 'dsh-batch-worker', parentSessionId: 'sess_parent-1', iteration: 3 }) }),
    JSON.stringify({ timestamp: new Date(Date.now() - 2000).toISOString(), event: 'model.request.started', module: 'core.runtime', sessionId: `sess_subagent_${runningAgentId}`, context: JSON.stringify({ queryId: 'query_fixture', iteration: 3, modelId: 'GLM-5.3-Flash' }) }),
    JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), event: 'zcode_protocol.process.memory_sample', module: 'bootstrap.zcode_protocol', context: '{"rssKb":1}' }),
  ].join('\n') + '\n')

  const parsed = runsModule.parseReport('outcome: partial\ncounts: processed=3 changed=1 skipped=1 failed=1\nCHANGED: D:/x\nFAILED:  D:/y — boom\n')
  check('parseReport reads outcome + counts', parsed.outcome === 'partial' && parsed.counts?.processed === 3 && parsed.counts?.failed === 1, JSON.stringify(parsed.counts))
  check('parseReport separates items by prefix', parsed.items.length === 2 && parsed.items[1].kind === 'failed', parsed.items.map((item) => item.kind).join(','))

  const runs = await runsModule.describeRuns(fixture)
  const running = runs.agents.find((agent) => agent.agentId === runningAgentId)
  const finished = runs.agents.find((agent) => agent.agentId === doneAgentId)
  check('fixture: the unfinished run reads as running', running?.running === true && running?.stale === false, JSON.stringify({ running: running?.running, status: running?.status }))
  check('fixture: the running run sits first', runs.agents[0]?.agentId === runningAgentId, runs.agents.map((agent) => agent.agentId).join(','))
  check('fixture: open request marks it generating', running?.generating === true && runs.live.generating === true && runs.live.openRequests === 1, JSON.stringify({ generating: running?.generating, open: runs.live.openRequests }))
  check('fixture: the live tool call is surfaced', running?.activity?.lastTool === 'Edit' && running?.currentTool?.name === 'Edit', JSON.stringify(running?.activity ?? null))
  check('fixture: the live phase is surfaced', running?.activity?.phase === 'regular_turn_loop' && running?.activity?.running === true, String(running?.activity?.phase))
  check('fixture: the busy flag ignores the idle heartbeat', runs.live.busy === true, `busy=${runs.live.busy}`)
  check('fixture: the finished run carries its own report', finished?.running === false && finished?.outcome === 'done' && finished?.counts?.changed === 2, JSON.stringify(finished?.counts ?? null))
  check('fixture: the finished run keeps its duration and tokens', finished?.durationMs === 30_000 && finished?.tokens === 222 && finished?.toolUses === 3, `${finished?.durationMs}ms ${finished?.tokens} tokens`)
  check('fixture: turns are counted from the transcript', (running?.turns ?? 0) === 2, String(running?.turns))
  check('fixture: counts summarise both runs', runs.counts.running === 1 && runs.counts.completed === 1, JSON.stringify(runs.counts))
  check('fixture: the parent session rollup lists children', runs.tasks.length === 0 && runs.sessions.some((entry) => entry.sessionId === 'sess_parent-1'), `${runs.sessions.length} sessions`)
  check('fixture: a missing task index degrades quietly', runs.indexAvailable === false && Array.isArray(runs.notes), String(runs.indexAvailable))
  check('fixture: no prompt text leaks into the snapshot', !JSON.stringify(runs).includes('PROMPT-MUST-NOT-APPEAR') && !('prompt' in (running ?? {})))

  rmSync(fixture, { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} FAILED: ${failed.map((entry) => entry.label).join('; ')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
