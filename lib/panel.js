/**
 * The panel page: one self-contained HTML document, no build step and no React.
 *
 * Deliberately NOT shaped like a model-provider card: there is no API key field,
 * because nothing here is reached by an API key. It shows the account behind the
 * running GUI client, the grant, the live balance, and what the client has loaded.
 *
 * @param statusRoute - the JSON route this page polls.
 * @returns the full HTML document.
 */
export function renderPanel(statusRoute) {
  const route = JSON.stringify(statusRoute)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZCode 连接器</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --bar:#22c55e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2f3237; --card:#1f2124; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:13px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif; }
  h1 { font-size:14px; margin:0 0 2px; font-weight:600; }
  .sub { color:var(--muted); font-size:11px; margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; }
  .k { color:var(--muted); }
  .v { text-align:right; font-variant-numeric:tabular-nums; }
  .big { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
  .bar { height:8px; border-radius:999px; background:var(--line); overflow:hidden; margin:8px 0 6px; }
  .bar > i { display:block; height:100%; background:var(--bar); }
  .tag { display:inline-block; padding:1px 6px; border-radius:6px; border:1px solid var(--line); font-size:11px; color:var(--muted); margin:2px 4px 0 0; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  button { font:inherit; padding:4px 10px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td, th { text-align:left; padding:3px 0; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  td:last-child, th:last-child { text-align:right; }
  .foot { color:var(--muted); font-size:11px; margin-top:8px; }
  code { font-size:11px; color:var(--muted); }
</style>
</head>
<body>
  <h1>ZCode 连接器 <span id="dot" class="tag">读取中…</span></h1>
  <div class="sub">数据来自正在运行的 ZCode 客户端（CDP）与它自己的套餐接口 —— 不是 API key</div>

  <div class="card" id="grant">
    <div class="k">套餐 / 额度</div>
    <div class="big" id="remain">—</div>
    <div class="bar"><i id="barfill" style="width:0%"></i></div>
    <div class="row"><span class="k" id="used">—</span><span class="v" id="expire">—</span></div>
  </div>

  <div class="card">
    <div class="row"><span class="k">账户</span><span class="v" id="account">—</span></div>
    <div class="row"><span class="k">当前通道 / 模型</span><span class="v" id="channel">—</span></div>
    <div class="row"><span class="k">ZCode 客户端</span><span class="v" id="app">—</span></div>
    <div class="row"><span class="k">GUI 桥 (bridge)</span><span class="v" id="bridge">—</span></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">装载能力（客户端已配置的通道）</div>
    <table><thead><tr><th>通道</th><th>协议</th><th>模型</th><th>状态</th></tr></thead><tbody id="caps"></tbody></table>
    <div class="foot" id="capsfoot"></div>
  </div>

  <div class="card">
    <div class="k" style="margin-bottom:6px">已安装到客户端（技能 / MCP）</div>
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
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const when = (s) => (typeof s === 'number' ? new Date(s * 1000).toLocaleString() : '—');
const txt = (id, value, cls) => { const el = document.getElementById(id); el.textContent = value; el.className = 'v ' + (cls || ''); };

async function load() {
  const dot = document.getElementById('dot');
  try {
    const res = await fetch(ROUTE, { cache: 'no-store' });
    const s = await res.json();
    const bal = (s.grant && s.grant.balances && s.grant.balances[0]) || null;
    const plan = (s.grant && s.grant.plans && s.grant.plans[0]) || null;

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
    txt('bridge', s.bridge && s.bridge.reachable ? ('可用 · 队列 ' + (s.bridge.inflight ?? 0)) : '未运行', s.bridge && s.bridge.reachable ? 'ok' : 'warn');

    const caps = (s.capabilities && s.capabilities.channels) || [];
    document.getElementById('caps').innerHTML = caps.map((c) =>
      '<tr><td>' + (c.key || '') + '</td><td>' + (c.api || '') + '</td><td>' + (c.models || []).length +
      '</td><td class="' + (c.enabled ? 'ok' : '') + '">' + (c.enabled ? (c.keyPresent ? '启用' : '启用(无key)') : '停用') + '</td></tr>').join('')
      || '<tr><td colspan="4" class="k">未读到客户端配置</td></tr>';
    document.getElementById('capsfoot').textContent = s.capabilities
      ? '已知模板 ' + s.capabilities.knownTemplates + ' · 插件 ' + ((s.capabilities.plugins || []).length) + ' · 启用通道 ' + ((s.capabilities.enabledChannels || []).join(', ') || '无')
      : '';

    const inst = s.installed || { skills: [], mcpServers: [] };
    const rows = [
      ...inst.skills.map((k) => ['技能', k.name, (k.description || '').slice(0, 60), '可用']),
      ...inst.mcpServers.map((m) => ['MCP', m.name, m.target, m.enabled ? '自动连接' : '已停用']),
    ];
    document.getElementById('installed').innerHTML = rows.map((r) =>
      '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td><code>' + r[2] + '</code></td><td class="' + (r[3] === '已停用' ? '' : 'ok') + '">' + r[3] + '</td></tr>').join('')
      || '<tr><td colspan="4" class="k">尚未安装任何东西</td></tr>';
    document.getElementById('installedfoot').textContent = s.installed
      ? '技能目录 ' + s.installed.roots.skills + ' · MCP 用户级 ' + s.installed.roots.userConfig
      : '';

    const ents = (plan && plan.entitlements) || [];
    document.getElementById('ents').innerHTML = ents.map((e) =>
      '<tr><td>' + (e.showName || '') + '</td><td><code>' + ((e.capabilities || []).join(', ')) + '</code></td><td>' + fmt(e.grantUnits) + ' ' + (e.unitType || '') + '</td></tr>').join('')
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
setInterval(load, 30000);
</script>
</body>
</html>`
}
