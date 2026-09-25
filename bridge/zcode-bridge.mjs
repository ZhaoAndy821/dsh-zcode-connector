/**
 * zcode-bridge.mjs —— 把 ZCode 桌面端(GUI) 当作一个 OpenAI 兼容的模型后端。
 *
 * 为什么这样接：Start Plan 的额度是**账号绑定**（`access.type: zhipu-account`），
 * 只走 `zcode.z.ai/api/v1/zcode-plan/anthropic`，而那条路要求渲染进程现签的
 * 阿里云验证头（直连实测 3007）。所以正确做法是**驱动官方客户端**，让 App 自己去签，
 * 而不是伪造证明。本文件通过 CDP 驱动 ZCode 的输入框并读回回复。
 *
 * 使用限制（这些是必须知道的运行约束）：
 *   1. ZCode 必须开着，且启动时带 `--remote-debugging-port=9333`。
 *   2. **串行**：一个对话、一个输入框，本桥内建队列，同刻只跑一个请求。
 *   3. 频道必须是 Start Plan：每次请求前核对底部模型标签，不对就自动切过去。
 *   4. 每次请求开一个**新对话**（点"新建任务"），避免上下文叠加。
 *   5. ZCode 必须开着，但**不需要在前台**：最小化/被遮挡/未聚焦都行（事件投递给渲染进程，
 *      与窗口层级无关）；关掉它才会断。用户在同一对话里手动打字会干扰本次请求。
 *   6. **窗口位置和大小随便**：本桥从不读窗口坐标，attach 时把渲染进程视口钉在 VIEWPORT
 *      （默认 1280×900），之后每次动作都重算元素中心 + 命中测试。唯一的几何要求是输入框和
 *      发送键留在视口内；窄到把它们裁掉时报定位失败，不会瞎点。
 *   7. ZCode 是 agent 不是裸模型：若它在 UI 里打开了项目目录，它可能真的去动文件。
 *   8. 上游报错会原样抛出（如 `[1113] 余额不足…`），不返回空串。
 *
 * 用法：
 *   node zcode-bridge.mjs [--port 9444]
 *   然后 POST http://127.0.0.1:9444/v1/chat/completions  (OpenAI 兼容, 非流式)
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HTTP_PORT = Number(process.env.ZCODE_BRIDGE_PORT ?? 9444)
const CDP_PORT = Number(process.env.ZCODE_CDP_PORT ?? 9333)
const VIEWPORT = { width: Number(process.env.ZCODE_VIEWPORT_W ?? 1280), height: Number(process.env.ZCODE_VIEWPORT_H ?? 900) }
const REPLY_TIMEOUT_MS = Number(process.env.ZCODE_REPLY_TIMEOUT_MS ?? 240_000)
const STABLE_SAMPLES = 3
const SAMPLE_INTERVAL_MS = 1200

const CONTROL_TOKENS = /(复制|编辑|赞|踩|分叉|展开详情|反馈问题|重试|已工作 \d+ 秒|已工作 \d+ 分 \d+ 秒|刚刚|\d+分)/g

// ─────────────────────────────── CDP 通道 ───────────────────────────────
async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html')) ?? targets.find((t) => t.type === 'page')
  if (!page) throw new Error(`ZCode 页面没找到；确认它带 --remote-debugging-port=${CDP_PORT} 在跑`)

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 0
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(`页面内报错: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
  return result.result.value
}

async function clickPoint(cdp, x, y) {
  const point = { x, y, button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
}

/**
 * 定位 → 校验 → 点击。校验两件事，任一不过就抛错（不盲点）：
 *   1. 稳定性：120ms 后同一个元素的 bounding box 不变（排除动画/布局漂移）
 *   2. 命中：document.elementFromPoint(中心) 落在该元素自身或其子孙上（排除被遮挡/坐标偏）
 * 这是"用脚本检测位置对不对"的那一步；仅靠 querySelector 拿坐标是不够的。
 */
async function locate(cdp, queryBody, what) {
  const raw = await evaluate(cdp, `(() => {
    ${FIND_HELPERS}
    const el = (() => { ${queryBody} })();
    if (!el) return null;
    el.setAttribute('data-zc-target', '1');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: textOf(el).slice(0, 60) });
  })()`)
  if (!raw) throw new Error(`定位失败（${what}）`)
  const box = JSON.parse(raw)
  await sleep(120)
  const check = await evaluate(cdp, `(() => {
    const el = document.querySelector('[data-zc-target="1"]');
    if (!el) return JSON.stringify({ ok: false, why: '元素消失' });
    const r = el.getBoundingClientRect();
    const stable = Math.abs(r.x - ${box.x}) < 1 && Math.abs(r.y - ${box.y}) < 1;
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const onTarget = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    return JSON.stringify({ ok: stable && onTarget, stable, onTarget, cx, cy, hitTag: hit ? hit.tagName : null });
  })()`)
  const verdict = JSON.parse(check)
  await evaluate(cdp, `(() => { const el = document.querySelector('[data-zc-target="1"]'); if (el) el.removeAttribute('data-zc-target'); return true; })()`)
  if (!verdict.ok) throw new Error(`点击前校验未通过（${what}）: 稳定=${verdict.stable} 命中=${verdict.onTarget} 命中元素=${verdict.hitTag}`)
  return { centre: { x: verdict.cx, y: verdict.cy }, text: box.text }
}

async function clickBy(cdp, queryBody, what) {
  const found = await locate(cdp, queryBody, what)
  await clickPoint(cdp, found.centre.x, found.centre.y)
  return found
}

const FIND_HELPERS = `
  const visible = (el) => Boolean(el && el.offsetParent !== null && el.getClientRects().length > 0);
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const centreOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const turns = () => [...document.querySelectorAll('.history-message')].filter((el) => !/group\\/history-message/.test(String(el.className)));
`

/** 底部模型标签：'GLM-5.3-Flash' = Start Plan；'bigmodel-api/…' = 那条没余额的普通通道。
 *  注意：新建任务时空对话的输入框在页面中央，所以不能按 y 坐标筛，只能取"最靠下"的那个。 */
const MODEL_LABEL_EXPR = `(() => {
    ${FIND_HELPERS}
    const el = [...document.querySelectorAll('span, button')]
      .filter((e) => visible(e) && /GLM-5\\.3-Flash/.test(textOf(e)) && textOf(e).length < 45)
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
    return el ? textOf(el) : null;
  })()`

async function readModelLabel(cdp) {
  return evaluate(cdp, MODEL_LABEL_EXPR)
}

async function ensureStartPlan(cdp) {
  const label = await readModelLabel(cdp)
  if (label && !label.includes('/')) return label
  // 频道不是 Start Plan（显示成 'bigmodel-api/…'）→ 打开选择器切过去
  await clickBy(cdp, `
    const list = [...document.querySelectorAll('span, button')]
      .filter((e) => visible(e) && /GLM-5\\.3-Flash/.test(textOf(e)) && textOf(e).length < 45);
    return list.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
  `, '模型选择器')
  await sleep(1200)
  await clickBy(cdp, `
    const list = [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter((e) => visible(e) && /GLM-5\\.3-Flash/.test(textOf(e)));
    return list[0];
  `, 'Start Plan 条目')
  await sleep(1500)
  const after = await readModelLabel(cdp)
  if (after && after.includes('/')) throw new Error(`切换 Start Plan 失败，当前频道: ${after}`)
  return after
}

async function newTask(cdp) {
  await clickBy(cdp, `
    const list = [...document.querySelectorAll('[role="group"]')]
      .filter((e) => visible(e) && /新建任务/.test(textOf(e)) && textOf(e).length < 30);
    return list[0];
  `, '新建任务')
  await sleep(1200)
}

async function typePrompt(cdp, text) {
  // Select whatever is already in the composer first: `Input.insertText` replaces the
  // selection, and without this the prompt is APPENDED to leftovers (measured: a stale
  // skill reference rode along with the prompt and the model echoed it back).
  const prepared = await evaluate(cdp, `(() => {
    ${FIND_HELPERS}
    const editor = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!editor) return 'no editor';
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.activeElement === editor ? 'ok' : 'not focused';
  })()`)
  if (prepared !== 'ok') throw new Error(`输入框准备失败: ${prepared}`)

  await cdp.send('Input.insertText', { text })
  await sleep(300)

  // Verify what actually landed before committing to send.
  const landed = await evaluate(cdp, `(() => {
    const editor = document.querySelector('div[role="textbox"][contenteditable="true"]');
    return editor ? editor.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`)
  const wanted = text.replace(/\s+/g, ' ').trim()
  if (landed !== wanted) throw new Error(`输入框内容与预期不符: 期望 ${JSON.stringify(wanted.slice(0, 60))} 实际 ${JSON.stringify(String(landed).slice(0, 60))}`)

  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function waitForReply(cdp, before) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS
  let previous = null
  let stable = 0
  while (Date.now() < deadline) {
    await sleep(SAMPLE_INTERVAL_MS)
    // Two independent signals, because neither is sufficient alone:
    //   · the composer shows 停止生成 while streaming and 发送 once the turn is over
    //     (text stability alone lied: a fan-out turn looked frozen while its subagents ran)
    //   · the answer itself is read from the client's own transcript, because the DOM
    //     UNLOADS collapsed turns — a finished agentic turn had an empty body there
    const snapshot = await evaluate(cdp, `(() => {
      ${FIND_HELPERS}
      const list = turns();
      const body = (document.body.innerText || '');
      const busy = /停止生成|工作中/.test(body);
      const idle = /(^|\\s)发送(\\s|$)/.test(body.replace(/\\s+/g, ' '));
      if (list.length === 0) return JSON.stringify({ state: 'empty', busy, idle });
      const last = list[list.length - 1];
      return JSON.stringify({ state: 'turn', text: textOf(last), busy, idle });
    })()`)
    const { busy, idle } = JSON.parse(snapshot)
    if (busy) {
      stable = 0
      continue
    }
    const answer = readMainTurnAnswer(before)
    if (answer !== null && answer === previous && idle) {
      stable += 1
      if (stable >= STABLE_SAMPLES) return answer
    } else {
      stable = 0
      previous = answer
    }
  }
  throw new Error(`等待回复超时(${REPLY_TIMEOUT_MS}ms)`)
}

const ROLLOUT_DIR = join(homedir(), '.zcode', 'cli', 'rollout')

/** Sizes of every session transcript, so a later read can tell which one is ours. */
function transcriptSizes() {
  const sizes = new Map()
  try {
    for (const name of readdirSync(ROLLOUT_DIR)) {
      if (!name.startsWith('model-io-sess_') || !name.endsWith('.jsonl')) continue
      if (name.includes('subagent')) continue
      sizes.set(name, statSync(join(ROLLOUT_DIR, name)).size)
    }
  } catch {
    /* no transcript yet */
  }
  return sizes
}

/**
 * The assistant's final text for the turn, from ZCode's own per-request transcript.
 *
 * Records are `{querySource, request:{body}, response:{text, toolCalls}}`; the app writes its
 * own session-title request into the same file, so `querySource === 'main_turn'` is the filter
 * and the LAST such record is the merged answer (earlier ones are tool-calling rounds).
 */
function readMainTurnAnswer(before) {
  const candidates = []
  for (const [name, size] of transcriptSizes()) {
    const previous = before?.get(name)
    if (previous === undefined || size > previous) {
      candidates.push({ name, size, mtime: statSync(join(ROLLOUT_DIR, name)).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates) {
    let lines
    try {
      lines = readFileSync(join(ROLLOUT_DIR, candidate.name), 'utf8').trim().split('\n')
    } catch {
      continue
    }
    let answer = null
    for (const line of lines) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.querySource !== 'main_turn') continue
      const text = typeof record.response?.text === 'string' ? record.response.text.trim() : ''
      if (text.length > 0) answer = text
    }
    if (answer !== null) return answer
  }
  return null
}

// ─────────────────────────────── 串行队列 ───────────────────────────────
let chain = Promise.resolve()
let inflight = 0
function serialize(task) {
  const run = chain.then(task, task)
  chain = run.catch(() => {})
  return run
}

// ─────────────────────────────── HTTP ───────────────────────────────
function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 4 * 1024 * 1024) reject(new Error('body 过大')) })
    request.on('end', () => resolve(raw))
    request.on('error', reject)
  })
}

function lastUserText(messages) {
  const user = [...(messages ?? [])].reverse().find((message) => message.role === 'user')
  if (!user) return ''
  if (typeof user.content === 'string') return user.content
  if (Array.isArray(user.content)) return user.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  return String(user.content ?? '')
}

const server = createServer(async (request, response) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }

  if (request.method === 'GET' && request.url?.startsWith('/healthz')) {
    return send(200, { ok: true, inflight, cdpPort: CDP_PORT })
  }
  if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
    return send(200, { object: 'list', data: [{ id: 'zcode/GLM-5.3-Flash', object: 'model', owned_by: 'zcode-start-plan' }] })
  }
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
    return send(404, { error: { message: 'only POST /v1/chat/completions' } })
  }

  let payload
  try {
    payload = JSON.parse(await readBody(request))
  } catch (error) {
    return send(400, { error: { message: `bad json: ${error.message}` } })
  }
  const prompt = lastUserText(payload.messages)
  if (!prompt) return send(400, { error: { message: 'no user message' } })

  inflight += 1
  const startedAt = Date.now()
  try {
    const reply = await serialize(async () => {
      const cdp = await attach()
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
        await newTask(cdp)
        const channel = await ensureStartPlan(cdp)
        const transcriptsBefore = transcriptSizes()
        await typePrompt(cdp, prompt)
        const text = await waitForReply(cdp, transcriptsBefore)
        if (!text) throw new Error('回复为空')
        if (/\[\d{4}\]|余额不足|captcha verify failed|登录|请充值/.test(text)) throw new Error(`上游报错: ${text.slice(0, 200)}`)
        return { text, channel }
      } finally {
        cdp.close()
      }
    })
    console.log(`[bridge] ok ${Date.now() - startedAt}ms channel=${reply.channel} prompt=${prompt.slice(0, 40)}… reply=${reply.text.slice(0, 60)}…`)
    return send(200, {
      id: `chatcmpl-zcode-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'zcode/GLM-5.3-Flash',
      choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  } catch (error) {
    console.error(`[bridge] fail after ${Date.now() - startedAt}ms: ${error.message}`)
    return send(502, { error: { message: error.message } })
  } finally {
    inflight -= 1
  }
})

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`zcode-bridge on http://127.0.0.1:${HTTP_PORT}  (CDP ${CDP_PORT}, viewport ${VIEWPORT.width}x${VIEWPORT.height})`)
  console.log('限制: ZCode 必须开着(带调试端口) · 串行 · 每请求新对话 · 频道必须是 Start Plan')
})
