/**
 * The panel page: one self-contained HTML document, no build step and no React.
 *
 * Deliberately NOT shaped like a model-provider card: there is no API key field,
 * because nothing here is reached by an API key. It shows the account behind the
 * running GUI client, the grant, the live balance, what the client has loaded, and —
 * the part the DSH sidebar cannot show on its own — what the client is executing
 * right now: its background tasks and its subagent runs.
 *
 * @param statusRoute - the JSON route this page polls.
 * @param bridgeStartRoute - the loopback route that starts the GUI bridge on demand.
 * @returns the full HTML document.
 */
export function renderPanel(statusRoute, bridgeStartRoute = '/plugins/dsh-zcode-connect/bridge/start') {
  const route = JSON.stringify(statusRoute)
  const startRoute = JSON.stringify(bridgeStartRoute)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZCode 连接器</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --bar:#22c55e; --hot:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2f3237; --card:#1f2124; --hot:#7aa2f7; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:13px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif; overflow-wrap:anywhere; }
  h1 { font-size:14px; margin:0 0 2px; font-weight:600; }
  .sub { color:var(--muted); font-size:11px; margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; flex-wrap:wrap; }
  .k { color:var(--muted); }
  .v { text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .big { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
  .bar { height:8px; border-radius:999px; background:var(--line); overflow:hidden; margin:8px 0 6px; }
  .bar > i { display:block; height:100%; background:var(--bar); }
  .tag { display:inline-block; padding:1px 6px; border-radius:6px; border:1px solid var(--line); font-size:11px; color:var(--muted); margin:2px 4px 0 0; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .hot { color:var(--hot); }
  button { font:inherit; padding:4px 10px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  table { width:100%; border-collapse:collapse; font-size:12px; table-layout:fixed; }
  td, th { text-align:left; padding:3px 0; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
  th { color:var(--muted); font-weight:500; }
  td:last-child, th:last-child { text-align:right; }
  #runs td:last-child, #runs th:last-child { width:56px; }
  .foot { color:var(--muted); font-size:11px; margin-top:8px; }
  code { font-size:11px; color:var(--muted); overflow-wrap:anywhere; }
  .live-dot { display:inline-block; width:7px; height:7px; border-radius:99px; background:var(--muted); margin-right:5px; vertical-align:middle; }
  .live-dot.on { background:var(--hot); box-shadow:0 0 0 3px color-mix(in srgb, var(--hot) 25%, transparent); }
  .indent { padding-left:14px; border-left:2px solid var(--line); }
  .agent-row td { color:var(--fg); }
  .agent-row .meta { color:var(--muted); font-size:11px; }
  .doing { color:var(--hot); font-size:11px; overflow-wrap:anywhere; }
  details summary { cursor:pointer; color:var(--muted); font-size:11px; }
</style>
</head>
<body>
  <h1>ZCode 连接器 <span id="dot" class="tag">读取中…</span></h1>
  <div class="sub">数据来自正在运行的 ZCode 客户端（CDP）与它自己的文件 —— 不是 API key</div>

  <div class="card">
    <div class="k" style="margin-bottom:4px"><span class="live-dot" id="livedot"></span>ZCode 后台</div>
    <div class="big" id="runhead">—</div>
    <div class="row"><span class="k" id="runsub">—</span><span class="v" id="runbeat">—</span></div>
    <div id="rundetail"></div>
  </div>

  <div class="card" id="grant">
    <div class="k">套餐 / 额度</div>
    <div class="big" id="remain">—</div>
    <div class="bar"><i id="barfill" style="width:0%"></i></div>
    <div class="row"><span class="k" id="used">—</span><span class="v" id="expire">—</span></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">任务与 subagent（客户端的运行记录）</div>
    <table><thead><tr><th>任务 / 角色</th><th>状态</th></tr></thead><tbody id="runs"></tbody></table>
    <div class="foot" id="runsfoot"></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">定时与空闲任务</div>
    <table><thead><tr><th>名称</th><th>计划</th><th>状态</th><th>下次</th></tr></thead><tbody id="autos"></tbody></table>
    <div class="foot" id="autosfoot"></div>
  </div>

  <div class="card">
    <div class="row"><span class="k">账户</span><span class="v" id="account">—</span></div>
    <div class="row"><span class="k">当前通道 / 模型</span><span class="v" id="channel">—</span></div>
    <div class="row"><span class="k">ZCode 客户端</span><span class="v" id="app">—</span></div>
    <div class="row"><span class="k">GUI 桥 (bridge)</span><span class="v" id="bridge">—</span></div>
    <div class="row" id="bridgerow" hidden><span class="k"></span><span class="v"><button id="bridgestart" onclick="startBridge()">按需启动桥</button></span></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">装载能力（客户端已配置的通道）</div>
    <table><thead><tr><th>通道</th><th>协议</th><th>模型</th><th>状态</th></tr></thead><tbody id="caps"></tbody></table>
    <div class="foot" id="capsfoot"></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">已安装到客户端（技能 / 子代理 / MCP）</div>
    <table><thead><tr><th>类型</th><th>名称</th><th>目标</th><th>状态</th></tr></thead><tbody id="installed"></tbody></table>
    <div class="foot" id="installedfoot"></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">套餐权益</div>
    <table><thead><tr><th>项目</th><th>能力</th><th>额度</th></tr></thead><tbody id="ents"></tbody></table>
    <div class="foot" id="notes"></div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:center">
    <span class="foot" id="stamp">—</span>
    <button onclick="load()">刷新</button>
  </div>

<script>
const ROUTE = ${route};
const BRIDGE_START = ${startRoute};
const esc = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const when = (s) => (typeof s === 'number' ? new Date(s * 1000).toLocaleString() : '—');
const clock = (ts) => (typeof ts === 'number' ? new Date(ts).toLocaleTimeString() : '—');
const txt = (id, value, cls) => { const el = document.getElementById(id); el.textContent = value; el.className = 'v ' + (cls || ''); };
const dur = (ms) => {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const minutes = Math.floor(ms / 60000), seconds = Math.round((ms % 60000) / 1000);
  if (minutes < 60) return minutes + 'm' + String(seconds).padStart(2, '0') + 's';
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
};
const ago = (ms) => {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  if (ms < 1500) return '刚刚';
  if (ms < 60000) return Math.round(ms / 1000) + ' 秒前';
  if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟前';
  if (ms < 86400000) return (ms / 3600000).toFixed(1) + ' 小时前';
  return Math.round(ms / 86400000) + ' 天前';
};
// Who starts the GUI bridge — the plugin's bridgeMode setting, said in the user's terms.
const MODES = {
  'on-demand': '按需启动',
  auto: '随宿主自启',
  off: '不托管',
};
// The client's phase names are internal; say what they mean in the user's terms.
const PHASES = {
  context_initialization: '准备上下文',
  session_start_hooks: '会话启动',
  session_persistence: '写入会话',
  turn_started_event: '开始本轮',
  target_accounting: '任务登记',
  user_prompt_hooks: '注入提示',
  regular_turn_loop: '推理与工具循环',
  tool_execution: '执行工具',
  turn_finalization: '收尾',
};
const statusCell = (run) => {
  if (run.generating) return '<span class="hot">生成中</span>';
  if (run.running) return '<span class="hot">运行中</span>';
  if (run.stale) return '<span class="warn">无响应</span>';
  if (run.outcome === 'blocked' || run.outcome === 'partial') return '<span class="bad">' + esc(run.outcome) + '</span>';
  if (run.outcome === 'done') return '<span class="ok">完成</span>';
  if (run.status && run.status !== 'completed') return '<span class="warn">' + esc(run.status) + '</span>';
  return '<span class="ok">完成</span>';
};

function renderRuns(s) {
  const runs = s.runs || {};
  const counts = runs.counts || {};
  const live = runs.live || {};
  const agents = runs.agents || [];
  const tasks = runs.tasks || [];
  const running = agents.filter((a) => a.running);
  const total = counts.running || 0;

  document.getElementById('livedot').className = 'live-dot' + (live.busy ? ' on' : '');
  document.getElementById('runhead').textContent = total > 0
    ? total + ' 个 subagent 正在运行'
    : (live.generating ? '客户端正在推理' : (live.busy ? '刚刚有活动' : '空闲'));
  document.getElementById('runsub').textContent =
    '累计 subagent ' + (counts.agents || 0) + ' 个 · 完成 ' + (counts.completed || 0) +
    (counts.problem ? ' · 需留意 ' + counts.problem : '') +
    (counts.stale ? ' · 无响应 ' + counts.stale : '') +
    ' · 工具调用 ' + (counts.toolUses || 0);
  const current = live.current;
  const phase = (name) => (name ? (PHASES[name] || name) : '');
  document.getElementById('runbeat').textContent = live.generating && current
    ? '推理中 · 已 ' + dur(current.waitingMs)
    : live.lastActivityAt
      ? '最近活动 ' + ago(live.quietForMs)
      : '无活动记录';

  // The main agent first: it is the level the client's own task cards live at, and it stays
  // visible between its turns instead of only while it is generating.
  const details = [];
  const main = live.main;
  if (main) {
    const state = main.generating
      ? '<span class="hot">推理中</span> · 已 ' + dur(main.waitingMs)
      : main.runningAgents > 0
        ? '<span class="hot">' + main.runningAgents + ' 个 subagent 在跑</span>'
        : main.open
          ? '<span class="hot">运行中</span>'
          : '<span class="ok">空闲</span>';
    details.push('<div class="indent" style="margin-top:6px;border-left-color:var(--hot)">' +
      '<div><strong>主 Agent</strong>' + (main.model ? ' · ' + esc(main.model) : '') +
      (main.status ? ' · ' + esc(main.status) : '') + '</div>' +
      '<div>' + esc((main.title || main.sessionId).slice(0, 60)) + '</div>' +
      '<div class="doing">' + state +
      (main.tool ? ' · 上一个工具 ' + esc(main.tool) : '') +
      // The phase is the last phase it was in, so it only means something while it is working.
      (main.phase && (main.generating || main.open) ? ' · ' + esc(phase(main.phase)) : '') + '</div>' +
      '<div class="meta" style="color:var(--muted);font-size:11px">轮次 ' + (main.turns || 0) +
      ' · 工具调用 ' + (main.toolCalls || 0) + ' · ' + fmt(main.tokens) + ' tokens' +
      ' · 派发 subagent ' + (main.agents || 0) + ' 个' +
      (main.lastActivityAt ? ' · ' + ago(Date.now() - main.lastActivityAt) : '') + '</div>' +
      '</div>');
  }

  // Running agents get their own block: this is the "what is it doing this second" view.
  details.push(...running.map((run) => {
    const activity = run.activity || {};
    const doing = activity.tool || run.currentTool?.name
      ? esc((activity.tool || run.currentTool.name) || '') + (run.currentTool?.target ? ' · ' + esc(run.currentTool.target) : '')
      : (activity.openRequests > 0 ? '推理中（已 ' + dur(activity.waitingMs) + '）' : '已派发，等待首个动作');
    return '<div class="indent" style="margin-top:6px">' +
      '<div>' + esc(run.role || 'subagent') + ' — ' + esc(run.description || '(无描述)') + '</div>' +
      '<div class="doing">' + doing + '</div>' +
      '<div class="meta" style="color:var(--muted);font-size:11px">已运行 ' + dur(run.durationMs) +
      ' · 轮次 ' + (activity.turns || run.turns || 0) + ' · 工具 ' + (activity.toolCalls || run.toolUses || 0) +
      ' · tokens ' + fmt(run.tokens) + '</div>' +
      '</div>';
  }));
  document.getElementById('rundetail').innerHTML = details.join('');

  // Group agents under the task that spawned them; orphans still get shown.
  const bySession = new Map();
  for (const run of agents) {
    const list = bySession.get(run.sessionId) || [];
    list.push(run);
    bySession.set(run.sessionId, list);
  }
  const rows = [];
  const seen = new Set();
  for (const task of tasks) {
    const children = bySession.get(task.taskId) || [];
    seen.add(task.taskId);
    const busy = task.open || task.live || children.some((child) => child.running);
    if (!busy && children.length === 0) continue;
    const label = (task.title || task.taskId).slice(0, 70);
    const busyChildren = children.filter((child) => child.running).length;
    const doing = busyChildren > 0
      ? busyChildren + ' 个 subagent 执行中'
      : task.currentTool
        ? '上一个工具 ' + task.currentTool
        : phase(task.phase);
    rows.push('<tr><td><strong>' + esc(label) + '</strong><div class="meta">' +
      (busy ? '运行中' : '完成') + (task.model ? ' · ' + esc(String(task.model).split('/').pop()) : '') +
      ' · ' + (children.length ? children.length + ' 个 subagent' : '无 subagent') +
      (task.tokens ? ' · ' + fmt(task.tokens) + ' tokens' : '') +
      (task.lastActivityAt ? ' · ' + ago(Date.now() - task.lastActivityAt) : '') + '</div>' +
      (doing && busy ? '<div class="doing">' + esc(doing) + '</div>' : '') + '</td>' +
      '<td>' + (busy ? '<span class="hot">运行中</span>' : '<span class="ok">完成</span>') + '</td></tr>');
    for (const child of children) {
      const items = (child.items || []).slice(0, 3).map((item) => item.kind + ': ' + item.path);
      const counts2 = child.counts
        ? Object.entries(child.counts).filter(([, value]) => value > 0).slice(0, 4).map(([key, value]) => key + '=' + value).join(' ')
        : '';
      rows.push('<tr class="agent-row"><td class="indent">' + esc(child.role || 'subagent') + ' — ' + esc((child.description || '').slice(0, 60)) +
        '<div class="meta">用时 ' + dur(child.durationMs) +
        (child.turns > 0 ? ' · 轮次 ' + child.turns : '') +
        ' · 工具 ' + (child.toolUses || 0) + ' · ' + fmt(child.tokens) + ' tokens' + (counts2 ? '<br>' + esc(counts2) : '') + '</div>' +
        (child.activity && child.activity.lastTool && child.running ? '<div class="doing">正在 ' + esc(child.activity.lastTool) + '</div>' : '') +
        (items.length ? '<details><summary>' + items.length + ' 项改动</summary><code>' + esc(items.join('\\n')) + '</code></details>' : '') +
        '</td><td>' + statusCell(child) + '</td></tr>');
    }
  }
  for (const [sessionId, children] of bySession) {
    if (seen.has(sessionId)) continue;
    for (const child of children) {
      rows.push('<tr class="agent-row"><td>' + esc(child.role || 'subagent') + ' — ' + esc((child.description || '').slice(0, 60)) +
        '<div class="meta">' + esc(sessionId.slice(0, 22)) + ' · 用时 ' + dur(child.durationMs) + '</div></td><td>' + statusCell(child) + '</td></tr>');
    }
  }
  document.getElementById('runs').innerHTML = rows.join('') ||
    '<tr><td colspan="2" class="k">还没有后台运行记录</td></tr>';
  document.getElementById('runsfoot').textContent =
    '记录目录 ' + ((runs.roots && runs.roots.agents) || '?') +
    ' · 最近 ' + agents.length + ' 条 · 改动 ' + (counts.itemsChanged || 0) + ' 项' +
    ((runs.notes || []).length ? ' · ' + (runs.notes || []).join(' · ') : '');

  const autos = (runs.automations && runs.automations.scheduled) || [];
  const offPeak = (runs.automations && runs.automations.offPeak) || [];
  const autoRows = autos.map((item) => '<tr><td>' + esc(item.title || item.id) + '</td><td><code>' + esc(item.cron || '—') +
    '</code></td><td>' + (item.running ? '<span class="hot">运行中</span>' : item.enabled ? '已启用' : '已停用') +
    '</td><td>' + (item.nextRunAt ? when(item.nextRunAt) : '—') + '</td></tr>')
    .concat(offPeak.map((item) => '<tr><td>' + esc(item.title || item.id) + '</td><td><code>空闲时段</code></td><td>' +
      esc(item.status || '') + '</td><td>' + (item.queuedAt ? when(item.queuedAt) : '—') + '</td></tr>'));
  document.getElementById('autos').innerHTML = autoRows.join('') ||
    '<tr><td colspan="4" class="k">没有定时任务（客户端未配置 Automations / 空闲任务）</td></tr>';
  document.getElementById('autosfoot').textContent = autos.length + ' 个定时任务 · ' + offPeak.length + ' 个空闲时段任务';
}

async function load() {
  const dot = document.getElementById('dot');
  try {
    const res = await fetch(ROUTE, { cache: 'no-store' });
    const s = await res.json();
    const bal = (s.grant && s.grant.balances && s.grant.balances[0]) || null;
    const plan = (s.grant && s.grant.plans && s.grant.plans[0]) || null;

    renderRuns(s);

    if (bal) {
      const total = bal.totalUnits ?? 0, left = bal.availableUnits ?? bal.remainingUnits ?? 0;
      document.getElementById('remain').textContent = fmt(left) + ' ' + (bal.unitType || 'tokens') + ' 可用';
      document.getElementById('barfill').style.width = (total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0) + '%';
      document.getElementById('used').textContent = '已用 ' + fmt(bal.usedUnits ?? 0) + ' / ' + fmt(total);
      document.getElementById('expire').textContent = '到期 ' + when(bal.expiresAt);
    } else {
      document.getElementById('remain').textContent = s.grant && s.grant.authenticated ? '无余额条目' : '未认证';
      document.getElementById('used').textContent = (s.grant && s.grant.errors && s.grant.errors.join(' · ')) || '';
    }

    const acc = s.account || {};
    txt('account', (acc.displayName || acc.username || '—') + (acc.id ? ' · ' + acc.id : ''), acc.hasAccountToken ? '' : 'bad');
    txt('channel', plan ? (plan.name || plan.planId || '—') + (bal && bal.showName ? ' · ' + bal.showName : '') : '—');
    txt('app', s.cdp && s.cdp.reachable ? ('运行中 · v' + (s.cdp.appVersion || '?') + ' · CDP ' + s.cdp.browser) : ('未连接（' + ((s.cdp && s.cdp.reason) || '') + '）'), s.cdp && s.cdp.reachable ? 'ok' : 'bad');
    const mode = (s.bridge && s.bridge.mode) || 'on-demand';
    txt('bridge', (s.bridge && s.bridge.reachable ? ('可用 · 队列 ' + (s.bridge.inflight ?? 0)) : '未运行') + ' · ' + MODES[mode], s.bridge && s.bridge.reachable ? 'ok' : 'warn');
    // On-demand means an explicit trigger is the whole point, so offer it exactly when it helps.
    const row = document.getElementById('bridgerow');
    row.hidden = !(mode === 'on-demand' && s.bridge && !s.bridge.reachable);

    const caps = (s.capabilities && s.capabilities.channels) || [];
    document.getElementById('caps').innerHTML = caps.map((c) =>
      '<tr><td>' + esc(c.key) + '</td><td>' + esc(c.api) + '</td><td>' + (c.models || []).length +
      '</td><td class="' + (c.enabled ? 'ok' : '') + '">' + (c.enabled ? (c.keyPresent ? '启用' : '启用(无key)') : '停用') + '</td></tr>').join('')
      || '<tr><td colspan="4" class="k">未读到客户端配置</td></tr>';
    document.getElementById('capsfoot').textContent = s.capabilities
      ? '已知模板 ' + s.capabilities.knownTemplates + ' · 插件 ' + ((s.capabilities.plugins || []).length) + ' · 启用通道 ' + ((s.capabilities.enabledChannels || []).join(', ') || '无')
      : '';

    const inst = s.installed || { skills: [], agents: [], mcpServers: [] };
    const rows = [
      ...(inst.skills || []).map((k) => ['技能', k.name, (k.description || '').slice(0, 60), '可用']),
      ...(inst.agents || []).map((a) => ['子代理', a.name, (a.description || '').slice(0, 60), '可派发']),
      ...(inst.mcpServers || []).map((m) => ['MCP', m.name, m.target, m.enabled ? '自动连接' : '已停用']),
    ];
    document.getElementById('installed').innerHTML = rows.map((r) =>
      '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td><td><code>' + esc(r[2]) + '</code></td><td class="' + (r[3] === '已停用' ? '' : 'ok') + '">' + r[3] + '</td></tr>').join('')
      || '<tr><td colspan="4" class="k">尚未安装任何东西</td></tr>';
    document.getElementById('installedfoot').textContent = s.installed
      ? '技能 ' + s.installed.roots.skills + ' · 子代理 ' + s.installed.roots.agents + ' · MCP ' + s.installed.roots.userConfig
      : '';

    const ents = (plan && plan.entitlements) || [];
    document.getElementById('ents').innerHTML = ents.map((e) =>
      '<tr><td>' + esc(e.showName) + '</td><td><code>' + esc((e.capabilities || []).join(', ')) + '</code></td><td>' + fmt(e.grantUnits) + ' ' + esc(e.unitType) + '</td></tr>').join('')
      || '<tr><td colspan="3" class="k">无</td></tr>';
    document.getElementById('notes').textContent = ((s.notes || []).concat((s.grant && s.grant.errors) || [])).join(' · ');
    document.getElementById('stamp').textContent = '更新于 ' + new Date(s.at).toLocaleTimeString();
    dot.textContent = '在线'; dot.className = 'tag ok';
  } catch (error) {
    dot.textContent = '读取失败'; dot.className = 'tag bad';
    document.getElementById('stamp').textContent = String(error);
  }
}
load();
setInterval(load, 15000);

// The on-demand path: the panel is a natural place to pull the bridge up when a session needs it.
async function startBridge() {
  const button = document.getElementById('bridgestart');
  button.disabled = true;
  button.textContent = '启动中…';
  try {
    const response = await fetch(BRIDGE_START, { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    button.textContent = response.ok ? '已启动' : ('失败: ' + (result.error || response.status));
  } catch (error) {
    button.textContent = '失败: ' + error;
  }
  load();
  setTimeout(() => { button.disabled = false; }, 3000);
}
</script>
</body>
</html>`
}
