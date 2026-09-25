/**
 * Provisioning: install skills and MCP servers into the ZCode client so its agent can
 * actually do the work we hand it.
 *
 * Authoritative locations, taken from the client's own `zcode-guide:diagnosing-mcp`
 * and `skill-creator` material rather than guessed:
 *
 *   skills   ~/.zcode/skills/<name>/SKILL.md          (verified: the agent listed an
 *                                                      installed skill back to us)
 *   mcp      ~/.zcode/cli/config.json → mcp.servers    (user scope, auto-connected)
 *            workspace: <dir>/.zcode/config.json or <dir>/zcode.json
 *            plugin:    <pluginRoot>/.mcp.json (namespaced plugin:<plugin>:<server>)
 *
 * Two rules the client states explicitly and this module therefore obeys:
 *   · the MCP server schema is STRICT — one unknown key and the server is dropped;
 *   · template variables are expanded only for plugin-provided servers, so file-scope
 *     servers must carry absolute paths.
 *
 * Everything here is additive and reversible: skills are directories we own, and the
 * MCP entries live under `mcp.servers` in a JSON file we read-modify-write with a backup.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ZCODE_HOME = join(homedir(), '.zcode')
const SKILLS_ROOT = join(ZCODE_HOME, 'skills')
const AGENTS_ROOT = join(ZCODE_HOME, 'agents')
const USER_CONFIG = join(ZCODE_HOME, 'cli', 'config.json')

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function assertName(name, what) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(`${what} 名不合法: ${JSON.stringify(name)} —— 只允许字母数字与 . _ -，长度 1..64`)
  }
  return name
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  if (existsSync(path)) renameSync(path, `${path}.bak-${Date.now()}`)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// ─────────────────────────────── 技能 ───────────────────────────────

/** Install (or replace) a skill at the user scope. */
export function installSkill({ name, description, body, force = false }) {
  assertName(name, '技能')
  if (typeof body !== 'string' || body.trim().length === 0) throw new Error('技能正文不能为空')
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('技能必须有 description —— 客户端靠它决定何时触发这个技能')
  }
  const dir = join(SKILLS_ROOT, name)
  const file = join(dir, 'SKILL.md')
  if (existsSync(file) && !force) throw new Error(`技能已存在: ${file}（要覆盖请传 force: true）`)

  // Frontmatter is what the client parses; the body is the instruction text.
  const frontmatter = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${frontmatter}${body.trim()}\n`, 'utf8')
  return { installed: true, name, path: file, bytes: Buffer.byteLength(body, 'utf8') }
}

/** Remove a skill we installed. Refuses anything outside the skills root. */
export function removeSkill(name) {
  assertName(name, '技能')
  const dir = join(SKILLS_ROOT, name)
  if (!dir.startsWith(SKILLS_ROOT)) throw new Error('拒绝删除技能根目录之外的路径')
  if (!existsSync(dir)) return { removed: false, name, reason: 'not installed' }
  rmSync(dir, { recursive: true, force: true })
  return { removed: true, name }
}

/** List skills installed at the user scope, with the description each declares. */
export function listSkills() {
  if (!existsSync(SKILLS_ROOT)) return []
  const skills = []
  for (const entry of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(SKILLS_ROOT, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^"|"$/g, '') ?? null
    skills.push({ name: entry.name, description, path: file })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// ─────────────────────────────── 子智能体 ───────────────────────────────

/**
 * Install a user-level subagent definition. Verified location: `~/.zcode/agents/<name>.md`
 * — a custom role written there showed up in the client's own subagent list
 * (`general-purpose, Explore, dsh-batch-worker, …`).
 *
 * The client's Settings → Subagents screen authors the same thing with name, colour, model,
 * thinking effort, description, tools and a system prompt; this writes the file directly.
 */
export function installAgent({ name, description, tools, model, body, force = false }) {
  assertName(name, '子智能体')
  if (typeof body !== 'string' || body.trim().length === 0) throw new Error('子智能体必须有自己的系统提示词（body）')
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('子智能体必须有 description —— 主 Agent 靠它决定何时派活给这个角色')
  }
  const file = join(AGENTS_ROOT, `${name}.md`)
  if (existsSync(file) && !force) throw new Error(`子智能体已存在: ${file}（要覆盖请传 force: true）`)

  const lines = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`]
  if (typeof tools === 'string' && tools.trim().length > 0) lines.push(`tools: ${tools.trim()}`)
  if (typeof model === 'string' && model.trim().length > 0) lines.push(`model: ${model.trim()}`)
  lines.push('---', '', body.trim(), '')

  mkdirSync(AGENTS_ROOT, { recursive: true })
  writeFileSync(file, lines.join('\n'), 'utf8')
  return { installed: true, name, path: file, bytes: Buffer.byteLength(body, 'utf8') }
}

/** Remove a subagent definition we installed. */
export function removeAgent(name) {
  assertName(name, '子智能体')
  const file = join(AGENTS_ROOT, `${name}.md`)
  if (!file.startsWith(AGENTS_ROOT)) throw new Error('拒绝删除 agents 根目录之外的路径')
  if (!existsSync(file)) return { removed: false, name, reason: 'not installed' }
  rmSync(file, { force: true })
  return { removed: true, name }
}

/** List user-level subagent definitions. */
export function listAgents() {
  if (!existsSync(AGENTS_ROOT)) return []
  return readdirSync(AGENTS_ROOT)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => {
      const text = readFileSync(join(AGENTS_ROOT, entry), 'utf8')
      return {
        name: entry.replace(/\.md$/, ''),
        description: /^description:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^"|"$/g, '') ?? null,
        tools: /^tools:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
        path: join(AGENTS_ROOT, entry),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ─────────────────────────────── MCP ───────────────────────────────

/** Field allow-list from the client's own docs: anything else drops the server. */
const STDIO_FIELDS = ['type', 'command', 'args', 'cwd', 'env', 'enabled', 'timeoutMs']
const HTTP_FIELDS = ['type', 'url', 'headers', 'enabled', 'timeoutMs']

function normalizeServer(spec) {
  const normalized = {}
  const isHttp = typeof spec?.url === 'string' && spec.url.length > 0
  if (isHttp) {
    normalized.type = 'http'
    normalized.url = spec.url
    if (spec.headers) normalized.headers = spec.headers
  } else if (typeof spec?.command === 'string' && spec.command.length > 0) {
    normalized.type = 'stdio'
    normalized.command = spec.command
    if (spec.args !== undefined) {
      if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string')) throw new Error('args 必须是字符串数组')
      normalized.args = spec.args
    }
    if (spec.cwd !== undefined) normalized.cwd = spec.cwd
    if (spec.env !== undefined) normalized.env = spec.env
  } else {
    throw new Error('MCP server 需要 command（stdio）或 url（http）之一')
  }
  if (spec.enabled !== undefined) normalized.enabled = spec.enabled === true
  if (spec.timeoutMs !== undefined) normalized.timeoutMs = Number(spec.timeoutMs)

  const allowed = isHttp ? HTTP_FIELDS : STDIO_FIELDS
  for (const key of Object.keys(normalized)) {
    if (!allowed.includes(key)) delete normalized[key]
  }
  return normalized
}

/** Install (or replace) a user-scope MCP server in ~/.zcode/cli/config.json. */
export function installMcpServer({ name, server, force = false }) {
  assertName(name, 'MCP server')
  const normalized = normalizeServer(server ?? {})
  const config = readJson(USER_CONFIG, {})
  config.mcp = config.mcp ?? {}
  config.mcp.servers = config.mcp.servers ?? {}
  if (config.mcp.servers[name] !== undefined && !force) {
    throw new Error(`MCP server 已存在: ${name}（要覆盖请传 force: true）`)
  }
  config.mcp.servers[name] = normalized
  writeJsonAtomic(USER_CONFIG, config)
  return { installed: true, name, server: normalized, path: USER_CONFIG, totalServers: Object.keys(config.mcp.servers).length }
}

/** Remove a user-scope MCP server. */
export function removeMcpServer(name) {
  assertName(name, 'MCP server')
  const config = readJson(USER_CONFIG, null)
  if (!config?.mcp?.servers?.[name]) return { removed: false, name, reason: 'not installed' }
  delete config.mcp.servers[name]
  writeJsonAtomic(USER_CONFIG, config)
  return { removed: true, name }
}

/** List user-scope MCP servers (name + how it is reached; never prints env/header values). */
export function listMcpServers() {
  const config = readJson(USER_CONFIG, {})
  return Object.entries(config?.mcp?.servers ?? {}).map(([name, server]) => ({
    name,
    type: server.type ?? (server.url ? 'http' : 'stdio'),
    target: server.url ?? [server.command, ...(server.args ?? [])].join(' '),
    enabled: server.enabled !== false,
    envKeys: Object.keys(server.env ?? {}),
    headerKeys: Object.keys(server.headers ?? {}),
  }))
}

/** One call for the panel: what we have installed on the client's behalf. */
export function listInstalled() {
  return {
    skills: listSkills(),
    agents: listAgents(),
    mcpServers: listMcpServers(),
    roots: { skills: SKILLS_ROOT, agents: AGENTS_ROOT, userConfig: USER_CONFIG },
  }
}
