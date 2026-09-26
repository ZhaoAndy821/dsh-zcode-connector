/**
 * Collect the observable state of the ZCode desktop app and its Start Plan grant.
 *
 * Three independent sources, each optional — a missing one degrades the panel
 * instead of failing it:
 *
 *   1. CDP          http://127.0.0.1:<debugPort>/json/version + /json/list
 *                   -> app running with a debug port, version, renderer URL
 *   2. credentials  ~/.zcode/v2/credentials.json, `enc:v1:` + AES-256-GCM where
 *                   key = sha256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:
 *                   <platform>:<homedir>:<username>") and the envelope is
 *                   `enc:v1:<b64url nonce12>.<b64url tag16>.<b64url ciphertext>`
 *                   -> the account token, used ONLY here to read the plan
 *   3. plan API     https://zcode.z.ai/api/v1/zcode-plan/billing/{current,balance}
 *                   with that bearer -> plans, entitlements, live balances
 *
 * Never returns a token, a refresh token, or any fragment of one. Identify values by
 * length only.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'
import { listInstalled } from './provision.js'
import { describeRuns } from './runs.js'

const PREFIX = 'enc:v1:'
const ZCODE_HOME = join(homedir(), '.zcode')
const PLAN_ORIGIN = 'https://zcode.z.ai'
/** path:size -> last balance reading parsed out of the client log. */
let balancesCache = null

/** Decrypt one `enc:v1:` value with the app's own fallback secret. */
function decryptCredential(value, secret) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value
  const parts = value.slice(PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('zcode-connect: malformed credential envelope')
  const [nonce, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'))
  const key = createHash('sha256').update(secret).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function credentialSecret() {
  return (
    process.env.ZCODE_CREDENTIAL_SECRET ??
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`
  )
}

/** Read + decrypt the app credential store. Throws a labelled error when unreadable. */
export function readCredentials(home = ZCODE_HOME) {
  let raw
  try {
    raw = readFileSync(join(home, 'v2', 'credentials.json'), 'utf8')
  } catch (error) {
    throw new Error(`zcode-connect: cannot read ZCode credentials (${error.code ?? error.message})`)
  }
  const store = JSON.parse(raw)
  const secret = credentialSecret()
  const decoded = {}
  for (const [name, value] of Object.entries(store)) {
    try {
      decoded[name] = decryptCredential(value, secret)
    } catch {
      decoded[name] = null
    }
  }
  return decoded
}

/** Account facts that are safe to show: identity only, plus whether a token exists. */
export function describeAccount(decoded) {
  let userInfo = null
  try {
    userInfo = JSON.parse(decoded['oauth:bigmodel:user_info'] ?? 'null')
  } catch {
    userInfo = null
  }
  const token = decoded.zcodejwttoken
  return {
    id: userInfo?.id ?? null,
    username: userInfo?.username ?? null,
    displayName: userInfo?.displayName ?? null,
    activeProvider: decoded['oauth:active_provider'] ?? null,
    hasAccountToken: typeof token === 'string' && token.length > 0,
    accountTokenLength: typeof token === 'string' ? token.length : 0,
    credentialKeys: Object.keys(decoded),
  }
}

/** CDP reachability + the app's own version string. */
export async function probeCdp(debugPort, timeoutMs = 3000) {
  const base = `http://127.0.0.1:${debugPort}`
  try {
    const version = await fetchJson(`${base}/json/version`, timeoutMs)
    const targets = await fetchJson(`${base}/json/list`, timeoutMs)
    const page = targets.find((target) => target.url.includes('renderer/index.html')) ?? targets.find((target) => target.type === 'page')
    const userAgent = String(version['User-Agent'] ?? '')
    const appVersion = /ZCode\/([\d.]+)/.exec(userAgent)?.[1] ?? null
    return {
      reachable: true,
      browser: version.Browser ?? null,
      appVersion,
      page: page ? { title: page.title ?? null, url: String(page.url).slice(0, 120) } : null,
    }
  } catch (error) {
    return { reachable: false, reason: error.message }
  }
}

/** The bridge helper (bridge/zcode-bridge.mjs), when running. */
export async function probeBridge(bridgePort, timeoutMs = 2000) {
  try {
    const health = await fetchJson(`http://127.0.0.1:${bridgePort}/healthz`, timeoutMs)
    return { reachable: true, inflight: health.inflight ?? null }
  } catch (error) {
    return { reachable: false, reason: error.message }
  }
}

/**
 * The grant: plans + entitlements from billing/current, live numbers from billing/balance.
 * Both need the account token; without it this reports `authenticated: false`.
 */
export async function fetchGrant(token, appVersion, timeoutMs = 8000) {
  if (typeof token !== 'string' || token.length === 0) {
    return { authenticated: false, reason: 'no account token in the credential store' }
  }
  // Measured: `balance` rejects an extra `platform` param with 3001 parameter error —
  // the app itself calls it with `app_version` only. `current` accepts both.
  const version = appVersion ?? '3.14.3'
  const balanceQuery = new URLSearchParams({ app_version: version })
  const currentQuery = new URLSearchParams({ app_version: version, platform: 'win32' })
  const headers = { authorization: `Bearer ${token}`, 'x-zcode-app-version': version, 'x-platform': 'win32' }
  const result = { authenticated: true, plans: [], balances: [], errors: [] }

  try {
    const current = await fetchJson(`${PLAN_ORIGIN}/api/v1/zcode-plan/billing/current?${currentQuery}`, timeoutMs, headers)
    for (const plan of current?.data?.plans ?? []) {
      result.plans.push({
        planId: plan.plan_id ?? null,
        name: plan.name ?? null,
        description: plan.description ?? null,
        status: plan.status ?? null,
        startsAt: plan.starts_at ?? null,
        endsAt: plan.ends_at ?? null,
        entitlements: (plan.entitlements ?? []).map((item) => ({
          showName: item.show_name ?? null,
          capabilities: item.capabilities ?? [],
          grantUnits: item.grant_units ?? null,
          unitType: item.unit_type ?? null,
          period: item.period ?? null,
          effectiveAt: item.effective_at ?? null,
        })),
      })
    }
  } catch (error) {
    result.errors.push(`current: ${error.message}`)
  }

  try {
    const balance = await fetchJson(`${PLAN_ORIGIN}/api/v1/zcode-plan/billing/balance?${balanceQuery}`, timeoutMs, headers)
    for (const bucket of balance?.data?.balances ?? []) {
      result.balances.push({
        showName: bucket.show_name ?? null,
        planId: bucket.plan_id ?? null,
        totalUnits: bucket.total_units ?? null,
        usedUnits: bucket.used_units ?? null,
        remainingUnits: bucket.remaining_units ?? null,
        availableUnits: bucket.available_units ?? null,
        unitType: bucket.unit_type ?? null,
        expiresAt: bucket.expires_at ?? null,
      })
    }
  } catch (error) {
    result.errors.push(`balance: ${error.message}`)
  }

  return result
}

/**
 * Live balances, read passively out of the client's own log.
 *
 * Why not ask the API: `GET /api/v1/zcode-plan/billing/balance` answers
 * `3001 parameter error` for every query/header combination tried (measured across
 * app_version / platform / client_version / scene, with and without the platform
 * header) — it evidently expects a credential this machine's store does not hold,
 * while `billing/current` accepts the same bearer. The client itself polls the
 * endpoint and logs the whole response, so the numbers are already on disk.
 *
 * @returns { at, balances } when a recent balance response is in the log, else null.
 */
/**
 * Read at most `limit` bytes from the end of a file, without materialising the whole thing.
 * The client's daily log reaches several MB and is read on every panel refresh.
 */
function readTail(path, limit) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size === 0) return null
  const length = Math.min(limit, stat.size)
  let handle = null
  try {
    handle = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(handle, buffer, 0, length, stat.size - length)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {
        /* already closed */
      }
    }
  }
}

export function readBalancesFromLog(home = ZCODE_HOME) {
  const day = new Date()
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const path = join(home, 'v2', 'logs', `${stamp}.log`)

  // This is the only working source for live balances (the plan API refuses `balance`), so it is
  // read on every refresh — memoise by size, which is what changes when the client logs again.
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  if (balancesCache !== null && balancesCache.path === path && balancesCache.size === size) return balancesCache.value

  const text = readTail(path, 8 * 1024 * 1024)
  if (text === null) return null

  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.includes('billing/balance') || !line.includes('"balances"')) continue

    const anchor = line.indexOf('"payload":')
    if (anchor === -1) continue
    const start = line.indexOf('{', anchor)
    let depth = 0
    let end = -1
    for (let cursor = start; cursor < line.length; cursor += 1) {
      if (line[cursor] === '{') depth += 1
      else if (line[cursor] === '}') {
        depth -= 1
        if (depth === 0) { end = cursor + 1; break }
      }
    }
    if (end === -1) continue

    let payload
    try {
      payload = JSON.parse(line.slice(start, end))
    } catch {
      continue
    }
    const balances = (payload?.data?.balances ?? []).map((bucket) => ({
      showName: bucket.show_name ?? null,
      planId: bucket.plan_id ?? null,
      totalUnits: bucket.total_units ?? null,
      usedUnits: bucket.used_units ?? null,
      remainingUnits: bucket.remaining_units ?? null,
      availableUnits: bucket.available_units ?? null,
      unitType: bucket.unit_type ?? null,
      expiresAt: bucket.expires_at ?? null,
    }))
    if (balances.length === 0) continue
    const loggedAt = /^\[([\d-]+ [\d:.]+)\]/.exec(line.trim())?.[1] ?? null
    const value = { at: loggedAt, balances }
    balancesCache = { path, size, value }
    return value
  }
  return null
}

/**
 * Where the client keeps its builtin provider catalog, when the config does not say.
 *
 * Two real locations, both on disk: the copy shipped inside the installed app, and the copy the
 * runtime materialises per platform/version/endpoint. `catalogPath` stays configurable for a
 * non-standard install; this is only the fallback, resolved once and then remembered.
 */
let catalogFallback
function findCatalogPath(home = ZCODE_HOME) {
  if (catalogFallback !== undefined) return catalogFallback
  const candidates = []
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    candidates.push(join(localAppData, 'Programs', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'))
  }
  try {
    const base = join(home, 'v2', 'runtime', 'provider')
    for (const platformDir of readdirSync(base)) {
      const platformPath = join(base, platformDir)
      for (const versionDir of readdirSync(platformPath)) {
        const versionPath = join(platformPath, versionDir)
        for (const endpointDir of readdirSync(versionPath)) {
          candidates.push(join(versionPath, endpointDir, 'zcode-builtin.json'))
        }
      }
    }
  } catch {
    /* the runtime copy is optional; the app copy usually wins anyway */
  }
  const found = candidates.find((path) => existsSync(path)) ?? null
  // Memoise a hit only: caching a miss would keep "0 templates" sticky for the whole process
  // if the first lookup ran before the app (or its catalog) existed.
  if (found !== null) catalogFallback = found
  return found
}

/**
 * What the app has loaded right now — the "capability" view.
 * Read from ZCode's own config + builtin catalog, so it reflects the client, not us.
 */
export function describeCapabilities(home = ZCODE_HOME, catalogPath) {
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }

  const config = readJson(join(home, 'v2', 'config.json'))
  const channels = []
  for (const [key, provider] of Object.entries(config?.provider ?? {})) {
    channels.push({
      key,
      name: provider.name ?? null,
      api: provider.kind ?? null,
      baseURL: provider.options?.baseURL ?? null,
      enabled: provider.enabled === true,
      keyPresent: typeof provider.options?.apiKey === 'string' && provider.options.apiKey.length > 0,
      models: Object.keys(provider.models ?? {}),
    })
  }

  const settings = readJson(join(home, 'v2', 'setting.json'))
  const resolvedCatalog = catalogPath ?? findCatalogPath(home)
  const catalog = resolvedCatalog ? readJson(resolvedCatalog) : null
  const templates = (catalog?.config?.providerConfigRules?.templateRules ?? []).map((template) => ({
    templateId: template.templateId,
    name: template.templateNameMap?.['zh-CN'] ?? template.templateId,
    api: template.config?.api?.type ?? null,
    access: template.config?.access?.type ?? null,
    modelCount: (template.config?.builtinModelIds ?? []).length,
  }))

  return {
    channels,
    enabledChannels: channels.filter((channel) => channel.enabled).map((channel) => channel.key),
    catalogPath: resolvedCatalog,
    knownTemplates: templates.length,
    templates,
    settingsKeys: settings ? Object.keys(settings) : [],
    plugins: Object.keys(readJson(join(home, 'cli', 'config.json'))?.plugins?.enabledPlugins ?? {}),
  }
}

async function fetchJson(url, timeoutMs, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`)
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One status snapshot for the panel. Cached by the caller, never cached here.
 * @param config - resolved plugin config (ports, catalog path).
 */
export async function collectStatus(config) {
  const status = {
    at: Date.now(),
    cdp: await probeCdp(config.debugPort),
    bridge: await probeBridge(config.bridgePort),
    account: null,
    grant: null,
    capabilities: null,
    runs: null,
    notes: [],
  }

  let decoded = null
  try {
    decoded = readCredentials()
    status.account = describeAccount(decoded)
  } catch (error) {
    status.notes.push(error.message)
  }

  if (decoded) {
    status.grant = await fetchGrant(decoded.zcodejwttoken, status.cdp.appVersion)
    // The plan API refuses `balance` (3001) — take the live numbers from the client's
    // own log, which it fills on every poll. See readBalancesFromLog for the evidence.
    if (status.grant.authenticated && (status.grant.balances ?? []).length === 0) {
      const fromLog = readBalancesFromLog()
      if (fromLog) {
        status.grant.balances = fromLog.balances
        status.grant.balancesSource = 'client-log'
        status.grant.balancesAt = fromLog.at
        status.grant.errors = status.grant.errors.filter((entry) => !entry.startsWith('balance:'))
      } else {
        status.grant.balancesSource = 'unavailable'
      }
    } else if (status.grant.authenticated) {
      status.grant.balancesSource = 'plan-api'
    }
  }

  try {
    status.capabilities = describeCapabilities(undefined, config.catalogPath)
  } catch (error) {
    status.notes.push(`capabilities: ${error.message}`)
  }

  // What this connector has installed on the client's behalf (skills + MCP servers).
  try {
    status.installed = listInstalled()
  } catch (error) {
    status.notes.push(`installed: ${error.message}`)
  }

  // The client's own background work: subagent runs, session activity, task index.
  // This is the part the DSH sidebar cannot see on its own — the runs happen inside
  // the ZCode process, not in this host.
  try {
    status.runs = await describeRuns()
  } catch (error) {
    status.notes.push(`runs: ${error.message}`)
  }

  return status
}
