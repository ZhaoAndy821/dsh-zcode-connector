# dsh-zcode-connect

ZCode（Z.ai 桌面端）连接器 —— **一个观测面板，不是模型 provider**。

## 真正干活的是客户端

ZCode 自己的渲染进程为每个请求现签验证证明，所以调用路径与你在 App 里手动按"发送"时是同一条。

- **同一批控件、同一批事件、同一条通道。** 桥通过公开的 Chromium DevTools Protocol 附加，操作真实控件 —— 内部实现没有复刻，也没有绕开 App 去打隐藏端点。
- **凭证只读，且只用于显示。** 账号 token 只做一件事：向客户端自己的套餐接口查询剩余额度，好让面板显示出来。它不出现在响应里、不写日志，自检脚本对此有断言。
- **一个账号、一个会话、一次只跑一个对话。** 桥按串行设计：没有并发调用路径，没有重试风暴。
- **客户端保持厂商原版。** 没有代理、没有注入证书、没有改动二进制。
- **发送前逐字校验。** 先把输入框清空，再校验落进去的内容与调用方写的完全一致。
- **回答取自客户端自己的转录**，不是从屏幕截图里抠 —— 所以工具调用很多的长回合也能完整取回。

## 它与正常用户的操作完全一致

**窗口不需要可见、不需要获得焦点、不需要置顶，甚至不需要还原。** 输入是通过 CDP 直接投递给渲染进程的，
与窗口层级和系统焦点无关 —— 所以 ZCode 可以一直最小化丢在别的窗口后面，只要它还在运行。
（实测：这个 App 就是以最小化状态启动的，下面每一次点击和按键都照样生效。）

除此之外没有任何异常：同一批控件、同一批事件、同一条请求路径。

| 真人会做 | 桥做的事 |
|---|---|
| 点侧栏 **新建任务** | 在该元素中心派发真实鼠标点击（`Input.dispatchMouseEvent`） |
| 点模型选择器、选套餐通道 | 同上；先读输入框的频道标签，并校验点击确实落在目标元素上 |
| 往输入框打字 | 聚焦、替换选区、发 `Input.insertText`，再**逐字校验**落进去的内容 |
| 按 **Enter** | `Input.dispatchKeyEvent` 的 Enter 键 |
| 看回答 | 读客户端自己的转录（`querySource === "main_turn"`）—— App 为它自己的历史写的那份记录 |

没有隐藏通道，也没有注入业务逻辑：自动化层只做点击、输入，以及读取客户端本来就会显示或落盘的东西。

## 可拓展性：把 ZCode 打造成脏活/累活/粗活的专用执行者

ZCode 本身就是一个扩展平台，而本连接器把这套扩展面通过 MCP 暴露出去 —— 于是调用方不只是"和它说话"，而是可以**改造它**：

| ZCode 的扩展点 | 位置 | 由谁安装 |
|---|---|---|
| 技能 Skills | `~/.zcode/skills/<名>/SKILL.md` | `zcode_install_skill` |
| 自定义子智能体（角色） | `~/.zcode/agents/<名>.md` | `zcode_install_agent` |
| MCP 服务器 | `~/.zcode/cli/config.json` → `mcp.servers` | `zcode_install_mcp` |
| 插件与市场 | 客户端自己的插件系统 | 客户端 UI |
| 定时任务 / 空闲任务 / cron 工具 | 客户端的调度面 | 客户端，或一句 prompt |

这套组合正是它适合干"量大的粗活"而不是"推理"的原因：**技能**教会它交付契约（交什么、什么格式），**子智能体角色**把一个小模型的活收窄到不会跑偏，**fan-out** 把大批量切成它真能做完的块，**MCP** 给它原本没有的工具，**automations** 让它在无人驱动时按节奏继续干。

实测：12 个文件，主 Agent 自报切成 2 块、并行起了两个 `dsh-batch-worker` 子智能体，各自回一份机器可解析的 `CHANGED:` 报告 —— 端到端 1 分 50 秒。

这套形状**不是 ZCode 专用的**：通过 CDP 附加、装技能与子智能体角色、再用 MCP 把这一切暴露出去 —— 对任何有自己扩展点的 Electron 客户端都成立。所以它值得作为**模板**而不是一次性脚本来发布。

## 为什么不是 provider / 不是 API key

ZCode 的 Start Plan（`zcode-v3-start-plan-*-wk`，如 `ZCode Weekend Build`，3 亿
GLM-5.3-Flash token）在客户端目录里声明为**账号绑定**：

```json
"access": { "type": "zhipu-account", "mode": "start-plan", "accountType": "bigmodel" },
"api":    { "type": "anthropic-messages", "baseUrl": "https://zcode.z.ai/api/v1/zcode-plan/anthropic" }
```

它唯一可用的推理入口要求渲染进程**逐请求现签**的阿里云验证头
（`X-Aliyun-Captcha-Verify-Param`）；直连实测 `3007 captcha verify failed`，
同一账号在平台上两条官方通道只回 `1113 余额不足或无可用资源包`。
所以**没有可交出来的 key**，把它写成 `llm-pi-ai.providers` 的 key 是错的接法。
这个插件的职责是观测：账户是谁、套餐是什么、还剩多少、客户端现在装载了什么。

## 它显示什么

- **余额**：`billing/balance` 的 `available_units / total_units / used_units` + 到期时间，带进度条
- **账户**：`oauth:bigmodel:user_info` 的 id / username / displayName，以及本地是否存在账号 token（只报长度，不显示内容）
- **客户端状态**：ZCode 是否以 `--remote-debugging-port=9333` 在跑、版本、CDP 浏览器串；以及 GUI 桥 `9444` 是否在跑、队列深度
- **装载能力**：读客户端自己的 `v2/config.json`，列出每个通道（协议 / baseURL / 是否启用 / key 是否存在 / 模型数），以及内置模板数与已启用插件
- **套餐权益**：`billing/current` 的 entitlements（项目名 / capabilities / 额度 / 周期）

## 两个路由

| 路由 | 内容 |
|---|---|
| `GET /plugins/dsh-zcode-connect/status` | JSON 快照（面板与脚本都用它） |
| `GET /plugins/dsh-zcode-connect/panel` | 自包含 HTML 面板（无构建步骤、无 React） |

两条都是**仅回环**：`request.socket.remoteAddress` 必须是 loopback，否则 403。

## 认证与密钥

读 `~/.zcode/v2/credentials.json`，格式是客户端自己的方案（从 app.asar 读出，非猜测）：

```
key    = sha256(process.env.ZCODE_CREDENTIAL_SECRET
                ?? `zcode-credential-fallback:${platform}:${homedir}:${username}`)
value  = "enc:v1:" + b64url(nonce12) + "." + b64url(authTag16) + "." + b64url(ciphertext)
cipher = aes-256-gcm
```

账号 token 只在请求套餐接口时作为 Bearer 使用；**任何返回体、日志、面板都不含 token 或它的片段**——账户信息里只有 `accountTokenLength`。

## 使用限制（这些是运行前提）

1. ZCode 必须**开着**，且以 `--remote-debugging-port=9333` 启动；**不需要在前台** —— 最小化、被遮挡、或放在别的虚拟桌面都行（事件投递给渲染进程而非操作系统窗口），只有关掉它才会断。没带端口时面板会明确显示"未连接"。
2. 插件自身**只读**：不发消息、不点按钮、不改客户端配置，因此不会消耗额度。
3. 面板要读套餐接口，需要账号 token 未过期；过期时 `grant.errors` 会原样显示。
4. 状态有 15 秒缓存（`cacheMs`），避免频繁打套餐接口。
5. 余额是**周末活动额度**，`expires_at` 到了就归零；它按天重置，面板显示的永远是当前可用。

## 配置

```yaml
- id: zcode-connect
  name: dsh-zcode-connect
  config:
    debugPort: 9333      # ZCode 的远程调试端口
    bridgePort: 9444     # bridge/zcode-bridge.mjs 的健康端口
    cacheMs: 15000
    # catalogPath: <可选> 客户端内置目录，用于列出"已知模板"数量
```

## 安装与挂载

1. `profiles/web/package.json`：`dependencies` 加
   `"dsh-zcode-connect": "link:%USERPROFILE%/.dsh/vendor-plugins/dsh-zcode-connect"`，
   `dsh.profile.bundles` 加 `"dsh-zcode-connect"`
2. 依赖桥：`<插件>/node_modules/@deepseek-ai` → junction 到
   `%USERPROFILE%/.dsh/profiles/node_modules/@deepseek-ai`
3. **重启宿主**后生效

## MCP 服务器（`mcp/server.mjs`）

同一个包里带一个零依赖的 MCP stdio 服务器（手写 JSON-RPC，换行分隔），DSH 通过
`@deepseek-ai/dsh-mcp-client` 消费它，工具名会变成 `mcp__zcode__*`：

| 工具 | 作用 | 是否花额度 |
|---|---|---|
| `zcode_status` | 套餐 / 实时余额 / 客户端已装载通道 | 否（只读） |
| `zcode_ask` | 把一段 prompt 经 GUI 桥发给 GLM-5.3-Flash，返回回复 | **是**（每次一问） |
| `zcode_install_skill` | 给 ZCode 的 Agent 装一个技能（`~/.zcode/skills/<名>/SKILL.md`） | 否 |
| `zcode_install_mcp` | 给 ZCode 装一个 MCP server（用户级 `~/.zcode/cli/config.json → mcp.servers`） | 否 |
| `zcode_capabilities` | 列出本插件已装了什么 | 否 |
| `zcode_uninstall` | 卸掉已装的技能或 MCP | 否 |

### 装到哪、凭什么

位置取自客户端自己的 `zcode-guide:diagnosing-mcp` 技能，不是猜的：

| 作用域 | 文件 | 字段 |
|---|---|---|
| 技能（用户级） | `~/.zcode/skills/<名>/SKILL.md` | frontmatter `name` + `description` |
| MCP（用户级） | `~/.zcode/cli/config.json` | `mcp.servers` |
| MCP（工作区） | `<dir>/.zcode/config.json` 或 `zcode.json` | `mcp.servers` |
| MCP（插件） | `<pluginRoot>/.mcp.json` | 命名空间 `plugin:<插件>:<server>` |

两条客户端明说的规矩，本插件照办：**MCP server 的 schema 是严格的，多一个未知字段整个 server 会被丢掉**（所以只写允许的字段）；**模板变量只对插件提供的 server 展开**（所以文件级一律用绝对路径）。

### 实测（不是推断）

- 装了 `dsh-handoff` 后，让客户端 Agent 自报技能 → 列表里出现 `dsh-handoff`
- 装了用户级 MCP `dsh-zcode` 后，同一问 → MCP 列表从 `node_repl, web_reader` 变成 `dsh-zcode, node_repl, web_reader`
- 反例：往工作区目录写 `.mcp.json` **不生效**（客户端只认 `<dir>/.zcode/config.json` 或 `<dir>/zcode.json`）

### 给 Agent 装的"脏活"契约

仓库里预置了三个技能文本（`skills/` 目录，可直接用 `zcode_install_skill` 安装）：

- `dsh-handoff` —— 收到带 `[DSH-HANDOFF]` 标记的任务时怎么做：先做完再回话、给出精确计数、每行 `CHANGED:`/`FAILED:` 前缀、不许边做边汇报
- `dsh-grunt-batch` —— 大批量机械活的输出契约（重命名/转换/抽取/重复性仓库杂活）
- `dsh-fanout` —— **分批与并行**：先枚举、按独立性切块（每块 5–15 个）、在一条消息里并行启动多个子智能体、合并报告、只重跑失败的那一块

### 分批次干（实测有效）

低阶模型一次吃不下大批量，切块交给子智能体才稳。链路是：

```
技能 dsh-fanout  →  主 Agent 用 Agent 工具启动子智能体（可并行）
子智能体定义     →  ~/.zcode/agents/<名>.md（等价于 Settings → Subagents 的自定义角色）
每个子智能体的产物 → ~/.zcode/cli/agents/sess_<会话>/agent_<id>/output.txt
```

实测（12 个文件、两个子智能体并行）：主 Agent 自报"已确认 12 个文件，拆成 2 块，每块 6 个，并行启动两个批处理工作线程"，
两个 worker 各自产出契约格式报告，全部 12 个文件改毕，耗时 1 分 50 秒。

### 循环 / 定时（原生能力，不必自己造）

ZCode 自带：**Automations → 定时任务**（可选每任务模型与思考强度）与 **Idle-time task**（无排期，空闲时排队跑，**免费**）。
Agent 工具面里还有 `CronCreate` / `CronList` / `CronDelete` / `Monitor` / `ScheduleWakeup`，
所以"让它自己跑 24 小时"可以直接用 prompt 让它建 cron，不需要外部循环。

## 自检

```yaml
- id: mcp-zcode
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: zcode
    command: node
    args: ['%USERPROFILE%/.dsh/vendor-plugins/dsh-zcode-connect/mcp/server.mjs']
    cwd: %USERPROFILE%/.dsh/vendor-plugins/dsh-zcode-connect
    toolCallTimeoutMs: 300000
    failOnStartupError: false
```

前提：ZCode 带 `--remote-debugging-port=9333` 在跑，且 `bridge/zcode-bridge.mjs` 在 9444 上。
缺哪个，`zcode_ask` 的报错就会点名哪一个（不会静默失败）。

## 自检

```powershell
node test/verify.mjs      # 导出面 / 路由接线 / 回环校验 / 无 token 泄漏 / 真实快照
```

## 面板形态

现在的面板是一张**自包含 HTML 页**（`/plugins/dsh-zcode-connect/panel`）：零构建步骤、零前端依赖，
在任何浏览器或 DSH 侧栏里都能直接打开。

想升级成原生 React 卡片时：用官方 `dsh.client` 打包流程把客户端半边产出为 combo bundle
（`exports["./client"]`），注册到 `settings.plugin.item`，key 用 `dsh-zcode-connect` —— 宿主半边
已经用 `installSection` 提供好这个命名空间，卡片不需要任何 key 字段。
