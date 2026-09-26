/**
 * Bridge lifecycle — the GUI bridge (`bridge/zcode-bridge.mjs`) is a separate process that drives
 * the ZCode window over CDP and answers OpenAI-style requests on 127.0.0.1:<bridgePort>. Nothing
 * in DSH starts it, so this module owns that decision, with three modes:
 *
 *   'on-demand' (default) — nobody starts it at boot; whatever needs it (an MCP `zcode_ask`, the
 *                           panel's 「启动桥」 button) calls ensureBridge() first.
 *   'auto'                — the plugin starts it while loading and stops it again on dispose.
 *   'off'                 — this connector never manages the process; it only reports reachability.
 *
 * Spawning is idempotent and race-tolerant: if the port already answers, nothing is started; and
 * if two callers race, the loser notices that the port came up (its own child exits on EADDRINUSE)
 * and reports the port rather than an error.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The copy shipped inside this plugin; `bridgeScript` in the config can point elsewhere. */
export const BUNDLED_BRIDGE = join(PLUGIN_ROOT, 'bridge', 'zcode-bridge.mjs')

/** The one child this process owns, if any. */
let owned = null

/** Is the bridge answering on this port? */
export async function probeBridge(port, timeoutMs = 2000) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })
      if (!response.ok) return { reachable: false, reason: `HTTP ${response.status}` }
      const body = await response.json().catch(() => null)
      return { reachable: true, inflight: body?.inflight ?? null, cdpPort: body?.cdpPort ?? null }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { reachable: false, reason: error.name === 'AbortError' ? 'timeout' : error.message }
  }
}

/** Which script a spawn would use, and whether it exists. */
export function resolveBridgeScript(configured) {
  const script = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : BUNDLED_BRIDGE
  return { script, exists: existsSync(script), bundled: script === BUNDLED_BRIDGE }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Make sure the bridge is up, starting it only when it is not.
 * @returns { reachable, started, pid?, script?, error? }
 */
export async function ensureBridge(options = {}) {
  const port = Number(options.port ?? 9444)
  const mode = options.mode ?? 'on-demand'
  const waitMs = options.waitMs ?? 8000
  const already = await probeBridge(port, 1200)
  if (already.reachable) return { reachable: true, started: false, inflight: already.inflight ?? null }
  if (mode === 'off') return { reachable: false, started: false, error: 'bridge management is off' }

  const { script, exists, bundled } = resolveBridgeScript(options.script)
  if (!exists) {
    return { reachable: false, started: false, error: `bridge script not found: ${script}`, script }
  }
  if (owned !== null && owned.exitCode === null) {
    // We already have one starting or running; let the wait below decide.
  } else {
    const child = spawn(process.execPath, [script, '--port', String(port)], {
      cwd: dirname(script),
      detached: false,
      stdio: options.onLog === undefined ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZCODE_BRIDGE_PORT: String(port) },
    })
    owned = child
    if (typeof options.onLog === 'function') {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => options.onLog(String(chunk).trim()))
      child.stderr?.on('data', (chunk) => options.onLog(String(chunk).trim()))
    }
    child.on('exit', (code, signal) => {
      if (owned === child) owned = null
      if (typeof options.onLog === 'function' && code !== 0 && signal === null) {
        options.onLog(`bridge exited with code ${code}${bundled ? '' : ` (${script})`}`)
      }
    })
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(250)
    const probe = await probeBridge(port, 1000)
    if (probe.reachable) return { reachable: true, started: true, pid: owned?.pid ?? null, script, inflight: probe.inflight ?? null }
  }
  return { reachable: false, started: true, pid: owned?.pid ?? null, script, error: `bridge did not answer on 127.0.0.1:${port} within ${waitMs} ms` }
}

/** Stop the bridge this process started, if any. A bridge we did not start is left alone. */
export function stopBridge() {
  if (owned === null) return { stopped: false, reason: 'not started by this process' }
  const child = owned
  owned = null
  try {
    child.kill()
    return { stopped: true, pid: child.pid }
  } catch (error) {
    return { stopped: false, reason: error.message }
  }
}

/** Whether this process currently owns a bridge child. */
export const bridgeOwned = () => (owned === null ? null : { pid: owned.pid, exitCode: owned.exitCode })
