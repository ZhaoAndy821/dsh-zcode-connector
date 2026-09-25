/**
 * ZCode (Z.ai) connector — host half.
 *
 * Registers two loopback routes on the web carrier:
 *   GET /plugins/dsh-zcode-connect/status   JSON snapshot (used by the panel + by me)
 *   GET /plugins/dsh-zcode-connect/panel    self-contained HTML panel (no build step)
 *
 * It registers NO LLM provider and holds NO API key: the Start Plan grant is
 * account-bound and only the GUI client can spend it, so this plugin's job is
 * observation — account, plan, remaining quota, and what the client has loaded.
 *
 * @module dsh-zcode-connect
 */
import z from '@deepseek-ai/schemastery'
import { collectStatus } from './status.js'
import { renderPanel } from './panel.js'

export const name = 'zcode-connect'

/** Only optional capabilities: a web carrier for the routes, settings for the card later. */
export const inject = []

/** Deployment-owned settings for the connector. */
export const Config = z.object({
  /** ZCode must be launched with `--remote-debugging-port=<debugPort>`. */
  debugPort: z.number().default(9333),
  /** bridge/zcode-bridge.mjs health port, when that helper is running. */
  bridgePort: z.number().default(9444),
  /** ZCode's builtin provider catalog, read only to describe known channels. */
  catalogPath: z.string(),
  /** Status cache window; the panel refreshes on demand and must not hammer the plan API. */
  cacheMs: z.number().default(15_000),
  statusRoute: z.string().default('/plugins/dsh-zcode-connect/status'),
  panelRoute: z.string().default('/plugins/dsh-zcode-connect/panel'),
})

function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalised = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalised === '::1' || normalised === '127.0.0.1' || normalised.startsWith('127.')
}

function send(response, status, body, contentType) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Register the status + panel routes.
 * @param ctx - context carrying the optional web carrier.
 * @param config - resolved connector configuration.
 */
export function apply(ctx, config) {
  const resolved = {
    debugPort: config.debugPort ?? 9333,
    bridgePort: config.bridgePort ?? 9444,
    catalogPath: config.catalogPath,
    cacheMs: config.cacheMs ?? 15_000,
    statusRoute: config.statusRoute ?? '/plugins/dsh-zcode-connect/status',
    panelRoute: config.panelRoute ?? '/plugins/dsh-zcode-connect/panel',
  }

  let cache = { at: 0, value: null }
  const status = async () => {
    const now = Date.now()
    if (cache.value !== null && now - cache.at < resolved.cacheMs) return cache.value
    const value = await collectStatus(resolved)
    cache = { at: now, value }
    return value
  }

  // Deferred through ctx.inject, not ctx.get: the carrier is not up at composition time
  // (measured on the previous plugin — ctx.get returned undefined and the route vanished).
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: resolved.statusRoute,
        handler: async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'GET only' }, 'application/json')
          if (!isLoopback(request.socket?.remoteAddress)) return send(response, 403, { error: 'loopback only' }, 'application/json')
          try {
            send(response, 200, await status(), 'application/json')
          } catch (error) {
            send(response, 500, { error: error.message }, 'application/json')
          }
        },
      }),
      `zcode-connect: GET ${resolved.statusRoute}`,
    )

    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: resolved.panelRoute,
        handler: (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'GET only', 'text/plain')
          if (!isLoopback(request.socket?.remoteAddress)) return send(response, 403, 'loopback only', 'text/plain')
          send(response, 200, renderPanel(resolved.statusRoute), 'text/html')
        },
      }),
      `zcode-connect: GET ${resolved.panelRoute}`,
    )
  })

  // Settings section: a namespace the client card can be dispatched for. No fields of
  // its own — the panel is read-only — but the card needs a served namespace to exist.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (settings === undefined || typeof settings.installSection !== 'function') {
      ctx.logger?.warn?.('zcode-connect: host settings service has no installSection API')
      return
    }
    settings.installSection(ctx, 'dsh-zcode-connect', z.object({}), config, {
      setSource() {
        return config
      },
      onChange() {},
    })
  })
}
