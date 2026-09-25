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
import { readFileSync } from 'node:fs'
import { createDecipheriv, createHash } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'

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

  const panelResponse = fakeResponse()
  routes[1].handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, panelResponse)
  check('panel renders HTML', panelResponse.captured.status === 200 && panelResponse.captured.body.startsWith('<!doctype html'), String(panelResponse.captured.status))
  check('panel embeds the status route', panelResponse.captured.body.includes('/plugins/dsh-zcode-connect/status'))
  check('panel HTML does not contain the account token', !panelResponse.captured.body.includes(token))
  check('panel has no API-key input (not a provider card)', !/<input[^>]+type=["']?password/i.test(panelResponse.captured.body) && !/api[_-]?key/i.test(panelResponse.captured.body.replace(/API key/g, '')), '')
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} FAILED: ${failed.map((entry) => entry.label).join('; ')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
