/**
 * ZCode background-run surface — read passively from the client's own files.
 *
 * The DSH sidebar only knows about DSH's own subagents and jobs. ZCode's agents run
 * *inside the client process*, so nothing about them appears there; but the client
 * writes every run to disk, and those files are readable while it works:
 *
 *   cli/agents/sess_<sid>/agent_<id>/metadata.json   one directory per subagent run:
 *                                                    role, task, status, tokens, tool count
 *   cli/agents/sess_<sid>/agent_<id>/output.txt      the worker's single report
 *   cli/rollout/model-io-sess_<...>.jsonl            one record per model round trip
 *                                                    (duration, tool calls, usage) — written
 *                                                    as the run proceeds, so it is the live
 *                                                    progress signal for an in-flight agent
 *   v2/tasks-index.sqlite                            task titles + scheduled/automation runs
 *
 * Everything here is read-only, size-capped, and degrades to `null`/`[]` rather than
 * throwing: a missing source must thin the panel, never break it.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TERMINAL = new Set(['completed', 'complete', 'failed', 'error', 'aborted', 'cancelled', 'canceled', 'stopped', 'timeout', 'expired'])
const OPEN_TASK = new Set(['running', 'in_progress', 'in-progress', 'working', 'streaming', 'pending', 'queued', 'dispatching', 'claimed'])

/** Activity newer than this means the client is doing work right now. */
const LIVE_MS = 45_000
/** A run with no completion stamp and no activity for this long is stalled, not running. */
const STALE_MS = 15 * 60_000
/** Cap on how much of one rollout transcript we will parse. */
const MAX_TRANSCRIPT_BYTES = 6 * 1024 * 1024
/** Cap on how much of the client log tail we will parse. */
const MAX_LOG_BYTES = 1_500_000
/** An "open" inference request older than this is a logging artefact, not a live turn. */
const MAX_OPEN_REQUEST_MS = 20 * 60_000
/** Turn-level events older than this are history, not current activity. */
const RECENT_ACTIVITY_MS = 20 * 60_000
/** Cap on how much of a worker report we will read (reports are paths + counts, never blobs). */
const MAX_REPORT_BYTES = 16 * 1024

/** path:size:mtime -> parsed transcript, so a 30 s panel refresh never re-parses 6 MB. */
const transcriptCache = new Map()
/** path:size -> parsed client-log activity, for the same reason. */
const activityCache = new Map()

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const statOrNull = (path) => {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** `readdirSync` that returns `[]` instead of throwing (a locked or vanished directory). */
const safeReaddir = (path) => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Read at most `limit` bytes from one end of a file, without loading the whole thing.
 *
 * The client's daily log reaches several MB and grows all day, and this runs on every panel
 * refresh — so the cap has to be applied by the read, not by slicing a string that was already
 * fully materialised.
 */
function readEnd(path, limit, fromEnd) {
  const stat = statOrNull(path)
  if (stat === null || !stat.isFile() || stat.size === 0) return null
  const length = Math.min(limit, stat.size)
  const start = fromEnd ? stat.size - length : 0
  let handle = null
  try {
    handle = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(handle, buffer, 0, length, start)
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

/** First `limit` bytes of a file. */
const readHeadBytes = (path, limit = MAX_REPORT_BYTES) => readEnd(path, limit, false)
/** Last `limit` bytes of a file — the live end of a log or transcript. */
const readTailBytes = (path, limit) => readEnd(path, limit, true)

/** First `limit` bytes of a file as text; workers' reports are small, so this is a cheap guard. */
function readHead(path, limit = MAX_REPORT_BYTES) {
  return readHeadBytes(path, limit)
}

const ms = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** filename -> full path for `cli/rollout`, rebuilt only when the directory listing changes. */
let rolloutIndex = { at: 0, signature: '', byAgent: new Map(), bySession: new Map() }

function readRolloutIndex(home) {
  const dir = join(home, 'cli', 'rollout')
  const names = safeReaddir(dir)
  const signature = `${names.length}:${names.join(',')}`
  if (rolloutIndex.signature === signature) return rolloutIndex
  const byAgent = new Map()
  const bySession = new Map()
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.slice('model-io-'.length, -'.jsonl'.length)
    bySession.set(sessionId, join(dir, name))
    const agentId = /agent_([0-9a-f-]{8,})/i.exec(sessionId)?.[1]
    if (agentId !== undefined) byAgent.set(agentId, join(dir, name))
  }
  rolloutIndex = { at: Date.now(), signature, byAgent, bySession }
  return rolloutIndex
}

/**
 * Find the rollout transcript for one subagent run.
 *
 * Measured on the live client: only 1 of 9 runs had a transcript at the exact name the session id
 * implies, so an exact-path read silently returned nothing for the rest. Look the file up by the
 * exact session id first, then by the agent id anywhere in the name.
 */
function resolveTranscript(home, childSessionId, agentId) {
  const index = readRolloutIndex(home)
  return index.bySession.get(childSessionId) ?? index.byAgent.get(agentId) ?? null
}

/**
 * Parse one `model-io-*.jsonl` transcript.
 * Records are appended as each model round trip completes, so the tail of this file is
 * the freshest evidence of what an agent is doing this second.
 */
function readTranscript(path) {
  const stat = statOrNull(path)
  if (stat === null || !stat.isFile()) return null
  const cacheKey = `${path}:${stat.size}:${stat.mtimeMs}`
  const cached = transcriptCache.get(cacheKey)
  if (cached !== undefined) return cached

  // Read only the tail: a transcript can reach several MB and grows while the agent works.
  // A cut at a byte boundary can leave one broken line, which the JSON.parse guard below drops.
  const text = readTailBytes(path, MAX_TRANSCRIPT_BYTES)
  if (text === null) return null
  const truncated = stat.size > MAX_TRANSCRIPT_BYTES

  const lines = text.split('\n')
  let turns = 0
  let toolUses = 0
  let model = null
  let provider = null
  let lastTurnAt = null
  let lastTool = null
  let lastText = null
  let tokens = 0

  for (const line of lines) {
    if (line.length < 2 || line.charCodeAt(0) !== 123) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // a half-written tail line while the agent is mid-turn
    }
    if (record === null || typeof record !== 'object') continue
    if (record.querySource === 'session_title') continue
    turns += 1
    model = record.model?.modelId ?? model
    provider = record.model?.providerId ?? provider
    const completedAt = ms(record.completedAt)
    if (completedAt !== null) lastTurnAt = completedAt
    const calls = record.response?.toolCalls
    if (Array.isArray(calls) && calls.length > 0) {
      toolUses += calls.length
      const call = calls[calls.length - 1]
      lastTool = { name: typeof call?.name === 'string' ? call.name : null, target: toolTarget(call?.input) }
    }
    const answer = record.response?.text
    if (typeof answer === 'string' && answer.trim().length > 0) lastText = answer.trim()
    const usage = record.response?.usage
    if (usage && typeof usage.totalTokens === 'number') tokens += usage.totalTokens
  }

  const result = {
    turns,
    toolUses,
    model,
    provider,
    lastTurnAt,
    lastTool,
    lastText: lastText === null ? null : lastText.slice(0, 400),
    tokens,
    transcriptBytes: stat.size,
    transcriptAt: stat.mtimeMs,
    truncated,
  }
  if (transcriptCache.size > 400) transcriptCache.clear()
  transcriptCache.set(cacheKey, result)
  return result
}

/** One short human-readable target for a tool call ("Edit D:\x\y.txt"). */
function toolTarget(input) {
  if (input === null || typeof input !== 'object') return null
  const candidate = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? null
  if (typeof candidate !== 'string') return null
  return candidate.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Parse a worker's own report: `outcome:`, the `counts:` line, and its item lines. */
export function parseReport(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { outcome: null, counts: null, items: [], lines: 0 }
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const outcome = /^outcome:\s*([A-Za-z_]+)/i.exec(lines[0]?.trim() ?? '')?.[1]?.toLowerCase() ?? null

  let counts = null
  const items = []
  for (const line of lines) {
    const trimmed = line.trim()
    const countsMatch = /^counts:\s*(.+)$/i.exec(trimmed)
    if (countsMatch !== null && counts === null) {
      counts = {}
      for (const pair of countsMatch[1].split(/\s+/)) {
        const [key, value] = pair.split('=')
        if (key && value !== undefined && /^\d+$/.test(value)) counts[key] = Number(value)
      }
    }
    const itemMatch = /^(CHANGED|CREATED|DELETED|SKIPPED|FAILED):\s*(.+)$/.exec(trimmed)
    if (itemMatch !== null && items.length < 40) {
      items.push({ kind: itemMatch[1].toLowerCase(), path: itemMatch[2].trim().slice(0, 200) })
    }
  }
  return { outcome, counts, items, lines: lines.length }
}

/** One subagent run, from its own directory. */
function describeAgent(home, sessionId, agentDir, agentId, now) {
  const dir = join(agentDir)
  const meta = readJson(join(dir, 'metadata.json'))
  const dirStat = statOrNull(dir)
  if (meta === null) {
    // Directory exists but metadata is mid-write; report the bare fact rather than dropping it.
    return {
      agentId,
      sessionId,
      role: null,
      description: null,
      status: 'unknown',
      running: false,
      stale: false,
      unreadable: true,
      startedAt: dirStat?.mtimeMs ?? null,
      updatedAt: dirStat?.mtimeMs ?? null,
      lastActivityAt: dirStat?.mtimeMs ?? null,
    }
  }

  const status = typeof meta.status === 'string' ? meta.status.toLowerCase() : 'unknown'
  const startedAt = ms(meta.startedAt) ?? ms(meta.createdAt)
  const completedAt = ms(meta.completedAt)
  const updatedAt = ms(meta.updatedAt) ?? completedAt
  const childSessionId = typeof meta.childSessionId === 'string' ? meta.childSessionId : `sess_subagent_${agentId}`
  const transcript = readTranscript(resolveTranscript(home, childSessionId, agentId))
  const reportText = readHead(meta.outputFile ?? join(dir, 'output.txt'))
  const report = parseReport(reportText)
  const lastActivityAt = Math.max(
    updatedAt ?? 0,
    transcript?.transcriptAt ?? 0,
    existsSync(join(dir, 'output.txt')) ? (statOrNull(join(dir, 'output.txt'))?.mtimeMs ?? 0) : 0,
  ) || null

  const closed = terminal(status) || completedAt !== null
  // `lastActivityAt` can legitimately be null for an in-flight run — the client writes
  // `updatedAt` only sometimes, the transcript is usually absent, and output.txt appears at the
  // end. Falling back to `startedAt` keeps the staleness guard meaningful: without it a run like
  // that reads as "running" forever, and it sorts first, is counted in counts.running and is
  // reported as RUNNING by the MCP digest.
  const quietBasis = lastActivityAt ?? startedAt
  const quietFor = quietBasis === null ? null : now - quietBasis
  const running = !closed && (quietFor === null || quietFor < STALE_MS)
  const stale = !closed && !running
  const durationMs =
    typeof meta.totalDurationMs === 'number' && meta.totalDurationMs > 0
      ? meta.totalDurationMs
      : startedAt !== null && completedAt !== null
        ? completedAt - startedAt
        : startedAt !== null
          ? now - startedAt
          : null

  // Measured: while a run is in flight the client writes `profileSnapshot` as a bare string
  // (the role name); it only becomes the full object — description + system prompt + tools —
  // once the run completes. Both shapes have to work, and the role name is all we surface.
  const snapshot = meta.profileSnapshot
  const roleName =
    typeof snapshot === 'string'
      ? snapshot
      : typeof snapshot?.name === 'string'
        ? snapshot.name
        : typeof meta.profileId === 'string'
          ? meta.profileId
          : null
  const roleDescription = typeof snapshot?.description === 'string' ? snapshot.description.slice(0, 160) : null
  const roleTools = Array.isArray(snapshot?.tools) ? snapshot.tools : null

  return {
    agentId,
    sessionId: typeof meta.parentSessionId === 'string' ? meta.parentSessionId : sessionId,
    childSessionId,
    role: roleName,
    roleDescription,
    tools: roleTools,
    description: typeof meta.description === 'string' ? meta.description.slice(0, 200) : null,
    status,
    running,
    stale,
    unreadable: false,
    startedAt,
    updatedAt,
    completedAt,
    lastActivityAt,
    quietForMs: quietFor,
    durationMs,
    tokens: typeof meta.totalTokens === 'number' ? meta.totalTokens : (transcript?.tokens ?? null),
    toolUses: typeof meta.totalToolUseCount === 'number' ? meta.totalToolUseCount : (transcript?.toolUses ?? null),
    usage: meta.usage ?? null,
    outcome: report.outcome,
    counts: report.counts,
    items: report.items,
    reportLines: report.lines,
    hasReport: typeof reportText === 'string' && reportText.trim().length > 0,
    turns: transcript?.turns ?? 0,
    model: transcript?.model ?? null,
    currentTool: transcript?.lastTool ?? null,
    lastText: transcript?.lastText ?? null,
    // Deliberately NOT returned: the full prompt (it can carry caller context) and the
    // system prompt. Only the short description and the report are surfaced.
  }
}

const terminal = (status) => TERMINAL.has(status)

/**
 * Live activity, straight out of the client's own event log.
 *
 * `cli/log/zcode-<date>.jsonl` records the runtime's turn lifecycle as it happens:
 *
 *   turn.phase.started        which phase the turn is in right now
 *   model.request.started     an inference request is open (… .completed closes it)
 *   tool.call.started / .completed   one tool invocation, with sessionId AND, for a
 *                                    subagent, agentId / agentType / parentSessionId
 *   model.response.diagnostics       finishReason, tool-call count, response length
 *   turn.completed            the turn closed, with its tool-call count
 *
 * This is what makes the panel live rather than historical: the rollout transcripts only
 * gain a record when a round trip *finishes*, but here an open request is visible while
 * the model is still emitting.
 *
 * @returns { at, openRequests, busy, lastEventAt, sessions: [...], bySession: Map }
 */
export function readActivityFromLog(home = join(homedir(), '.zcode'), options = {}) {
  const now = options.now ?? Date.now()
  const dir = join(home, 'cli', 'log')
  if (!existsSync(dir)) return { available: false, reason: 'no client log directory', at: now, sessions: [], bySession: new Map() }

  const today = new Date(now)
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const path = join(dir, `zcode-${stamp}.jsonl`)
  const stat = statOrNull(path)
  if (stat === null) return { available: false, reason: 'no log for today', path, at: now, sessions: [], bySession: new Map() }

  const cacheKey = `${path}:${stat.size}`
  const cached = activityCache.get(cacheKey)
  if (cached !== undefined) return repriceActivity(cached, now)

  // Read only the tail: the daily log is several MB and grows all day, on the hot path of
  // every panel refresh.
  const text = readTailBytes(path, MAX_LOG_BYTES)
  if (text === null) return { available: false, reason: 'log unreadable', path, at: now, sessions: [], bySession: new Map() }

  const sessions = new Map()
  const openRequests = new Map()
  const anonymousSeen = new Map()
  let abandonedRequests = 0
  let lastEventAt = null
  let lastEvent = null
  // The log also carries a background heartbeat (memory samples, polls) that ticks while the
  // client is idle — only turn-level events may count as "the client is doing work".
  let lastTurnAt = null
  const isTurnEvent = (event) => event.startsWith('turn.') || event.startsWith('tool.call.') || event.startsWith('model.')

  const sessionFor = (sessionId) => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = {
        sessionId,
        agentId: null,
        agentType: null,
        parentSessionId: null,
        model: null,
        turns: 0,
        iterations: 0,
        toolCalls: 0,
        lastTool: null,
        lastToolAt: null,
        lastToolDurationMs: null,
        phase: null,
        lastEventAt: null,
        lastFinishReason: null,
        lastResponseLength: null,
        openRequests: 0,
        openSince: null,
      }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  for (const line of text.split('\n')) {
    if (line.length < 2 || line.charCodeAt(0) !== 123) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const event = record.event
    if (typeof event !== 'string') continue
    const when = ms(record.timestamp)
    if (when !== null && (lastEventAt === null || when > lastEventAt)) {
      lastEventAt = when
      lastEvent = { event, module: record.module ?? null, sessionId: record.sessionId ?? null }
    }
    if (when !== null && isTurnEvent(event) && (lastTurnAt === null || when > lastTurnAt)) lastTurnAt = when
    const sessionId = record.sessionId
    if (typeof sessionId !== 'string') continue
    let context = record.context
    if (typeof context === 'string') {
      try {
        context = JSON.parse(context)
      } catch {
        context = null
      }
    }
    const entry = sessionFor(sessionId)
    if (typeof context === 'object' && context !== null) {
      if (typeof context.agentId === 'string') entry.agentId = context.agentId
      if (typeof context.agentType === 'string') entry.agentType = context.agentType
      if (typeof context.parentSessionId === 'string') entry.parentSessionId = context.parentSessionId
      if (typeof context.iteration === 'number') entry.iterations = Math.max(entry.iterations, context.iteration)
      if (typeof context.modelId === 'string') entry.model = context.modelId
      if (typeof context.turnNumber === 'number') entry.turns = Math.max(entry.turns, context.turnNumber + 1)
    }
    if (when !== null) entry.lastEventAt = Math.max(entry.lastEventAt ?? 0, when)

    // One request is identified by its queryId. Fall back to the turn id, and only then to a
    // per-session counter — `entry.openRequests` is not yet incremented while parsing, so using it
    // as the discriminator would collapse two concurrent anonymous requests into one key.
    const requestKey = context?.queryId
      ?? record.turnId
      ?? (anonymousSeen.set(sessionId, (anonymousSeen.get(sessionId) ?? 0) + 1), `anon#${anonymousSeen.get(sessionId)}`)
    const key = `${sessionId}:${requestKey}`

    if (event === 'model.request.started') {
      if (!openRequests.has(key)) openRequests.set(key, { sessionId, at: when, iteration: context?.iteration ?? null })
    } else if (event.endsWith('.failed')) {
      // A transport failure closes the request just as a completion does. Measured: one
      // `model.request.started` followed by model.request.failed + model.network.failed and no
      // closer at all (the retry used a NEW queryId), which otherwise reads as "generating" for
      // the full MAX_OPEN_REQUEST_MS window — the panel's headline claim, wrong for 20 minutes.
      openRequests.delete(key)
      entry.lastFailure = event
    } else if (event === 'model.request.completed' || event === 'model.network.completed' || event === 'model.sdk.stream.completed') {
      openRequests.delete(key)
      if (event === 'model.request.completed' && typeof context?.finishReason === 'string') entry.lastFinishReason = context.finishReason
    } else if (event === 'model.response.diagnostics') {
      openRequests.delete(key)
      if (typeof context?.responseLength === 'number') entry.lastResponseLength = context.responseLength
      if (typeof context?.finishReason === 'string') entry.lastFinishReason = context.finishReason
    } else if (event === 'tool.call.started') {
      entry.lastTool = typeof context?.toolName === 'string' ? context.toolName : entry.lastTool
      entry.lastToolAt = when
      entry.lastToolDurationMs = null
    } else if (event === 'tool.call.completed') {
      entry.toolCalls += 1
      if (typeof context?.toolName === 'string') entry.lastTool = context.toolName
      if (typeof record.durationMs === 'number') entry.lastToolDurationMs = record.durationMs
    } else if (event === 'turn.phase.started') {
      entry.phase = typeof context?.phase === 'string' ? context.phase : entry.phase
    }
  }

  for (const request of openRequests.values()) {
    // A request whose completion scrolled out of the window (or never got logged, as happens
    // for an aborted turn) would otherwise look open forever: measured one 71 minutes old.
    if (request.at === null || now - request.at > MAX_OPEN_REQUEST_MS) {
      abandonedRequests += 1
      continue
    }
    const entry = sessions.get(request.sessionId)
    if (entry === undefined) continue
    entry.openRequests += 1
    if (request.at !== null) entry.openSince = entry.openSince === null ? request.at : Math.min(entry.openSince, request.at)
  }

  const liveRequests = [...openRequests.values()].filter(
    (request) => request.at !== null && now - request.at <= MAX_OPEN_REQUEST_MS,
  )
  const list = [...sessions.values()]
    .map((entry) => ({
      ...entry,
      waitingMs: entry.openSince === null ? null : now - entry.openSince,
      quietForMs: entry.lastEventAt === null ? null : now - entry.lastEventAt,
      running: entry.openRequests > 0,
    }))
    .sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))

  const bySession = new Map(list.map((entry) => [entry.sessionId, entry]))
  const result = {
    available: true,
    path,
    at: now,
    logAt: stat.mtimeMs,
    openRequests: liveRequests.length,
    abandonedRequests,
    busy: liveRequests.length > 0,
    lastEventAt,
    lastTurnAt,
    lastEvent,
    // Only what is current: a session whose last turn-level event is inside the window.
    // The full map stays available through `bySession` for per-agent lookups.
    sessions: list.filter((entry) => entry.running || (entry.lastEventAt !== null && now - entry.lastEventAt < RECENT_ACTIVITY_MS)),
    bySession,
    // Everything above except the parse-derived counters depends on `now`; the cache keeps the
    // parse and `repriceActivity` re-derives the time-dependent view for a caller's own clock.
    openRequestList: [...openRequests.values()],
    parsedAt: now,
    cacheKey,
  }
  if (activityCache.size > 8) activityCache.clear()
  activityCache.set(cacheKey, result)
  return result
}

/**
 * Re-derive the time-dependent parts of a cached log reading for a *fresh* clock.
 *
 * The parse is cached by file size, which does not change while the client sits idle — or dies
 * with a request open. Without this, `busy`/`waitingMs`/`running` would be frozen at parse time
 * and the panel would claim "generating · 3s" forever.
 */
export function repriceActivity(activity, now = Date.now()) {
  if (activity?.available !== true) return activity
  if (activity.parsedAt === now) return activity

  const perSession = new Map()
  let liveCount = 0
  for (const request of activity.openRequestList ?? []) {
    if (request.at === null || now - request.at > MAX_OPEN_REQUEST_MS) continue
    liveCount += 1
    const current = perSession.get(request.sessionId)
    if (current === undefined) perSession.set(request.sessionId, { count: 1, since: request.at })
    else {
      current.count += 1
      if (request.at < current.since) current.since = request.at
    }
  }

  const bySession = new Map()
  for (const [sessionId, entry] of activity.bySession) {
    const open = perSession.get(sessionId) ?? null
    bySession.set(sessionId, {
      ...entry,
      openRequests: open === null ? 0 : open.count,
      openSince: open === null ? null : open.since,
      waitingMs: open === null ? null : now - open.since,
      quietForMs: entry.lastEventAt === null ? null : now - entry.lastEventAt,
      running: open !== null,
    })
  }

  return {
    ...activity,
    at: now,
    parsedAt: now,
    openRequests: liveCount,
    busy: liveCount > 0,
    bySession,
    sessions: [...bySession.values()]
      .filter((entry) => entry.running || (entry.lastEventAt !== null && now - entry.lastEventAt < RECENT_ACTIVITY_MS))
      .sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0)),
  }
}

/** Every subagent run the client has recorded, newest first, running ones always included. */
export function listAgentRuns(home = join(homedir(), '.zcode'), options = {}) {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 40
  const root = join(home, 'cli', 'agents')
  if (!existsSync(root)) return { runs: [], root }

  const runs = []
  // Every directory scan is inside its own guard: a directory removed or locked between a check
  // and the read must thin this section, never reject the whole snapshot.
  for (const sessionId of safeReaddir(root)) {
    const sessionDir = join(root, sessionId)
    if (statOrNull(sessionDir)?.isDirectory() !== true) continue
    for (const agentId of safeReaddir(sessionDir)) {
      const agentDir = join(sessionDir, agentId)
      if (statOrNull(agentDir)?.isDirectory() !== true) continue
      try {
        runs.push(describeAgent(home, sessionId, agentDir, agentId, now))
      } catch {
        /* one unreadable run must not hide the others */
      }
    }
  }

  runs.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    if (a.stale !== b.stale) return a.stale ? -1 : 1
    return (b.startedAt ?? 0) - (a.startedAt ?? 0)
  })
  const running = runs.filter((run) => run.running)
  const capped = runs.slice(0, Math.max(limit, running.length + 5))
  return { runs: capped, total: runs.length, root }
}

/** Parent-session rollup: which task spawned which agents, and is it still working. */
export function listSessions(home = join(homedir(), '.zcode'), options = {}) {
  const now = options.now ?? Date.now()
  const root = join(home, 'cli', 'rollout')
  if (!existsSync(root)) return { sessions: [], root }

  const bySession = new Map()
  for (const name of safeReaddir(root)) {
    if (!name.endsWith('.jsonl') || name.includes('subagent')) continue
    const sessionId = name.slice('model-io-'.length, -'.jsonl'.length)
    const transcript = readTranscript(join(root, name))
    if (transcript === null) continue
    bySession.set(sessionId, {
      sessionId,
      turns: transcript.turns,
      toolUses: transcript.toolUses,
      model: transcript.model,
      provider: transcript.provider,
      tokens: transcript.tokens,
      lastActivityAt: transcript.transcriptAt,
      lastTool: transcript.lastTool,
      live: now - transcript.transcriptAt < LIVE_MS,
    })
  }
  const sessions = [...bySession.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { sessions, root }
}

/**
 * Task titles, per-task status, and the scheduled/automation surface, from the client's
 * own task index. Optional: `node:sqlite` may be missing on an older runtime, and the
 * client may be holding the file — both cases return `{ available: false }`.
 */
export async function readTaskIndex(home = join(homedir(), '.zcode'), options = {}) {
  const limit = options.limit ?? 12
  const path = join(home, 'v2', 'tasks-index.sqlite')
  if (!existsSync(path)) return { available: false, reason: 'no tasks-index.sqlite', path }

  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return { available: false, reason: 'node:sqlite unavailable on this runtime', path }
  }

  let db = null
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
    const tasks = db
      .prepare(
        `select task_id, title, task_status, model, mode, provider, created_at, updated_at, archived, deleted
           from tasks where deleted = 0 order by updated_at desc limit ?`,
      )
      .all(limit)
    const automations = db
      .prepare('select automation_id, title, cron_expr, enabled, lifecycle_status, run_count, next_run_at, last_run_at, running, dispatch_status, last_error, updated_at from automations order by updated_at desc limit 10')
      .all()
    const runs = db
      .prepare('select run_id, automation_id, scheduled_at, trigger, dispatch_status, outcome, error, attempts, updated_at from automation_runs order by updated_at desc limit 10')
      .all()
    const offPeak = db
      .prepare('select off_peak_task_id, title, status, queued_at, started_at, ended_at, failure_reason, attempt_count, last_error, updated_at from off_peak_tasks order by updated_at desc limit 10')
      .all()

    return {
      available: true,
      path,
      tasks: tasks.map((row) => ({
        taskId: row.task_id,
        title: typeof row.title === 'string' ? row.title.slice(0, 160) : null,
        status: row.task_status ?? null,
        open: OPEN_TASK.has(String(row.task_status ?? '').toLowerCase()),
        model: row.model ?? null,
        mode: row.mode ?? null,
        createdAt: typeof row.created_at === 'number' ? row.created_at : null,
        updatedAt: typeof row.updated_at === 'number' ? row.updated_at : null,
      })),
      automations: automations.map((row) => ({
        id: row.automation_id,
        title: row.title ?? null,
        cron: row.cron_expr ?? null,
        enabled: row.enabled === 1 || row.enabled === true,
        lifecycle: row.lifecycle_status ?? null,
        runCount: row.run_count ?? null,
        running: row.running === 1 || row.running === true,
        dispatch: row.dispatch_status ?? null,
        nextRunAt: row.next_run_at ?? null,
        lastRunAt: row.last_run_at ?? null,
        lastError: row.last_error ?? null,
      })),
      automationRuns: runs.map((row) => ({
        id: row.run_id,
        automationId: row.automation_id,
        scheduledAt: row.scheduled_at ?? null,
        trigger: row.trigger ?? null,
        dispatch: row.dispatch_status ?? null,
        outcome: row.outcome ?? null,
        error: row.error ?? null,
        attempts: row.attempts ?? null,
      })),
      offPeak: offPeak.map((row) => ({
        id: row.off_peak_task_id,
        title: row.title ?? null,
        status: row.status ?? null,
        queuedAt: row.queued_at ?? null,
        startedAt: row.started_at ?? null,
        endedAt: row.ended_at ?? null,
        attempts: row.attempt_count ?? null,
        lastError: row.last_error ?? null,
      })),
    }
  } catch (error) {
    return { available: false, reason: error.message, path }
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * The whole background picture: subagent runs + session activity + task index.
 * @returns a snapshot safe to serialise into the status route.
 */
export async function describeRuns(home = join(homedir(), '.zcode'), options = {}) {
  const now = options.now ?? Date.now()
  const agentRuns = listAgentRuns(home, { now, limit: options.limit })
  const sessions = listSessions(home, { now })
  const activity = readActivityFromLog(home, { now })
  const index = await readTaskIndex(home, { now })

  /** Trim one log-derived activity record to what the panel needs. */
  const liveDetail = (sessionId) => {
    const entry = activity.bySession?.get(sessionId)
    if (entry === undefined || entry === null) return null
    return {
      phase: entry.phase,
      iteration: entry.iterations,
      turns: entry.turns,
      toolCalls: entry.toolCalls,
      lastTool: entry.lastTool,
      lastToolAt: entry.lastToolAt,
      lastToolDurationMs: entry.lastToolDurationMs,
      openRequests: entry.openRequests,
      running: entry.running,
      waitingMs: entry.waitingMs,
      quietForMs: entry.quietForMs,
      lastFinishReason: entry.lastFinishReason,
      lastFailure: entry.lastFailure ?? null,
      agentType: entry.agentType,
      model: entry.model ?? null,
    }
  }

  // A request the client has open right now is the strongest "this is running" evidence —
  // stronger than any file mtime, and it works for subagents as well as for the main turn.
  //
  // The per-agent counters are merged across sources on purpose: the client rotates
  // `cli/rollout` (measured: a subagent transcript that existed at 22:16 was gone by 23:00, only
  // three main-session files remained), so the transcript is best-effort, while the log's
  // `tool.call.*` records survive for anything inside the log window and the finished run's own
  // `metadata.json` carries the totals for everything older.
  const agents = agentRuns.runs.map((run) => {
    const detail = liveDetail(run.childSessionId)
    const generating = (detail?.openRequests ?? 0) > 0
    return {
      ...run,
      running: run.running || generating,
      stale: run.stale && !generating,
      generating,
      activity: detail,
      turns: Math.max(run.turns ?? 0, detail?.turns ?? 0),
      model: run.model ?? detail?.model ?? null,
      currentTool: detail?.lastTool
        ? { name: detail.lastTool, target: run.currentTool?.target ?? null }
        : run.currentTool,
    }
  })

  const titles = new Map()
  for (const task of index.tasks ?? []) titles.set(task.taskId, task.title)

  const running = agents.filter((run) => run.running)
  const stale = agents.filter((run) => run.stale)
  const done = agents.filter((run) => !run.running && !run.stale)
  const problem = done.filter(
    (run) => run.outcome === 'blocked' || run.outcome === 'partial' || (terminal(run.status) && run.status !== 'completed'),
  )
  const completed = done.filter((run) => !problem.includes(run))

  const childrenBySession = new Map()
  for (const run of agents) {
    const list = childrenBySession.get(run.sessionId) ?? []
    list.push(run)
    childrenBySession.set(run.sessionId, list)
  }

  const tasks = (index.tasks ?? []).map((task) => {
    const children = childrenBySession.get(task.taskId) ?? []
    const session = sessions.sessions.find((entry) => entry.sessionId === task.taskId) ?? null
    const detail = liveDetail(task.taskId)
    return {
      ...task,
      title: task.title ?? null,
      live: session?.live === true || (detail?.openRequests ?? 0) > 0,
      turns: detail?.turns ?? session?.turns ?? 0,
      toolUses: detail?.toolCalls ?? session?.toolUses ?? 0,
      lastActivityAt: detail?.lastToolAt ?? session?.lastActivityAt ?? null,
      phase: detail?.phase ?? null,
      currentTool: detail?.lastTool ?? null,
      agents: children.length,
      runningAgents: children.filter((child) => child.running).length,
      tokens: children.reduce((sum, child) => sum + (child.tokens ?? 0), 0),
      detail,
    }
  })

  const inferenceAt = sessions.sessions.reduce((max, entry) => Math.max(max, entry.lastActivityAt ?? 0), 0)
  const agentActivityAt = agents.reduce((max, run) => Math.max(max, run.lastActivityAt ?? 0), 0)
  const lastActivityAt = Math.max(inferenceAt, agentActivityAt, activity.lastTurnAt ?? 0) || null

  // The main agent itself: the primary session of the newest task. Subagent runs are what it
  // spawned; this is the thing that spawned them, and it is the level the client's own task
  // cards live at, so the panel shows it even when it is idle between turns.
  //
  // Measured trap: the newest *rollout file* is not necessarily the session that owns the runs —
  // the client does not write a rollout file for every session, so picking `sessions[0]` produced
  // a "主 Agent" card claiming "派发 subagent 0 个" directly above a table of nine runs. Prefer the
  // parent of the newest run, then the newest open task, then the newest session.
  const newestOpenTask = (index.tasks ?? []).find((task) => task.open) ?? null
  const mainSessionId = agents[0]?.sessionId ?? newestOpenTask?.taskId ?? sessions.sessions[0]?.sessionId ?? null
  const mainSession = sessions.sessions.find((entry) => entry.sessionId === mainSessionId) ?? null
  const mainDetail = mainSessionId === null ? null : liveDetail(mainSessionId)
  const mainTask = mainSessionId === null
    ? null
    : (index.tasks ?? []).find((task) => task.taskId === mainSessionId) ?? null
  const mainChildren = mainSessionId === null ? [] : (childrenBySession.get(mainSessionId) ?? [])
  const main = mainSessionId === null
    ? null
    : {
        sessionId: mainSessionId,
        title: titles.get(mainSessionId) ?? mainTask?.title ?? null,
        model: mainSession?.model ?? mainDetail?.model ?? null,
        status: mainTask?.status ?? null,
        open: mainTask?.open === true,
        generating: (mainDetail?.openRequests ?? 0) > 0,
        waitingMs: mainDetail?.waitingMs ?? null,
        phase: mainDetail?.phase ?? null,
        tool: mainDetail?.lastTool ?? mainSession?.lastTool?.name ?? null,
        turns: mainDetail?.turns ?? mainSession?.turns ?? 0,
        toolCalls: mainDetail?.toolCalls ?? mainSession?.toolUses ?? 0,
        tokens: mainSession?.tokens ?? 0,
        lastActivityAt: mainDetail?.lastToolAt ?? mainSession?.lastActivityAt ?? null,
        agents: mainChildren.length,
        runningAgents: mainChildren.filter((child) => child.running).length,
      }

  return {
    at: now,
    roots: { agents: agentRuns.root, rollout: sessions.root, index: index.path, log: activity.path ?? null },
    live: {
      lastActivityAt,
      quietForMs: lastActivityAt === null ? null : now - lastActivityAt,
      busy: activity.busy === true || (inferenceAt > 0 && now - inferenceAt < LIVE_MS),
      generating: activity.busy === true,
      openRequests: activity.openRequests ?? 0,
      runningAgents: running.length,
      liveSessions: sessions.sessions.filter((entry) => entry.live).length,
      lastEvent: activity.lastEvent ?? null,
      main,
      current: (() => {
        const entry = activity.sessions?.find((candidate) => candidate.running) ?? activity.sessions?.[0] ?? null
        if (entry === null) return null
        return {
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          agentType: entry.agentType,
          parentSessionId: entry.parentSessionId,
          model: entry.model,
          phase: entry.phase,
          tool: entry.lastTool,
          iteration: entry.iterations,
          toolCalls: entry.toolCalls,
          running: entry.running,
          waitingMs: entry.waitingMs,
          quietForMs: entry.quietForMs,
        }
      })(),
    },
    agents,
    sessions: sessions.sessions.slice(0, 10).map((entry) => ({ ...entry, title: titles.get(entry.sessionId) ?? null, detail: liveDetail(entry.sessionId) })),
    tasks,
    automations: index.available
      ? { scheduled: index.automations, runs: index.automationRuns, offPeak: index.offPeak }
      : { scheduled: [], runs: [], offPeak: [] },
    counts: {
      agents: agentRuns.total ?? agents.length,
      running: running.length,
      stale: stale.length,
      generating: agents.filter((run) => run.generating).length,
      completed: completed.length,
      problem: problem.length,
      tokens: agents.reduce((sum, run) => sum + (run.tokens ?? 0), 0),
      toolUses: agents.reduce((sum, run) => sum + (run.toolUses ?? 0), 0),
      itemsChanged: agents.reduce((sum, run) => sum + (run.items ?? []).filter((item) => item.kind === 'changed' || item.kind === 'created' || item.kind === 'deleted').length, 0),
    },
    indexAvailable: index.available,
    activityAvailable: activity.available === true,
    notes: [...(index.available ? [] : [`task index unavailable: ${index.reason}`]), ...(activity.available ? [] : [`client log unavailable: ${activity.reason}`])],
  }
}
