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

**窗口位置和大小不属于契约的一部分。** 这里有两个东西容易被混为一谈，连接器把它们分得很清楚：

| | 是什么 | 桥会动它吗 |
|---|---|---|
| 窗口 | 你从任务栏/程序坞打开的那个操作系统窗口 —— 一块显示面 | **不会**：不读、不移动、不缩放 |
| 渲染进程页面 | 那个窗口里的 Chromium 页面（`file://…/renderer/index.html`）—— 桥唯一 attach 的 CDP target | 只动它的**布局视口**，而且只在一次请求期间 |

页面 target 只有一个，就是你正在用的那个窗口的渲染进程；桥不会另开一个隐藏窗口。观测/面板那一半
完全不碰任何窗口 —— 它只读文件。

之所以要冻结页面视口：一轮可能跑几分钟，而流程是"先量元素中心、再点击"，这中间窗口若被拖动，
目标就移位了。冻结用的是**窗口当时已有的尺寸**加上它当时的 dpr，所以你看到的画面一个像素都不变，
而且请求一结束立刻释放。实测：把回落值故意设成 1000×700，桥的日志是
`viewport frozen at 1280x900 @1.5x (source: window)`；调用前布下的 override，调用后已消失 ——
页面回到自己的 1280×900、dpr 1.5。

App 按"被告知的视口"排版，并把输入框锚在距视口底边 73px 处（在 1244×802、1100×650、1280×900 三个
尺寸下实测一致）。所以**谎报一个比窗口更大的尺寸**，正是把输入框顶出窗口下缘的原因 —— 桥因此报的是
窗口自己的尺寸；`ZCODE_VIEWPORT_W` / `ZCODE_VIEWPORT_H` 只在窗口报不出可用尺寸（低于 640×480）时兜底。

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
- **后台运行状况**：客户端自己的 subagent 及其任务（见下一节）

## 后台与 subagent 的运行状况

ZCode 干活是在**它自己的进程里**干的：主 agent 派发 subagent、跑工具调用、一轮轮往下走。这些都不会流到发起方那边 —— DSH 侧边栏只列 DSH 自己的 subagent 和 job，看不见另一个应用里正在跑的东西。所以本插件直接读客户端自己的状态文件，把运行状况画进面板，也通过 MCP 暴露给 Agent：

| 显示 | 含义 |
|---|---|
| 正在运行的 subagent | 角色、分到的任务、**此刻正在执行的工具**（带目标路径）、已运行时长、轮次、工具调用数、tokens |
| 已完成的 subagent | 结论（`done` / `partial` / `blocked`）、用时、tokens、工具数，以及它自己报告里的 `CHANGED:` / `FAILED:` 清单 |
| 最近任务 | 客户端的任务列表，含每任务派了几个 subagent、总 tokens、最近活动时间 |
| 生成指示 | 此刻是否正在推理、已经等了多久 |
| 定时与空闲任务 | Automations 及其运行记录、空闲时段（off-peak）任务 |

整个过程是**被动读取**：读三个客户端本来就在写的文件，不注入、不轮询 GUI、不额外消耗额度。

| 来源 | 提供什么 |
|---|---|
| `~/.zcode/cli/agents/sess_*/agent_*/metadata.json` | 每个 subagent 运行一个目录：角色、任务、状态、tokens、工具数、用时 |
| `~/.zcode/cli/agents/sess_*/agent_*/output.txt` | worker 自己的报告，解析成结论 + 计数 + 改动清单 |
| `~/.zcode/cli/rollout/model-io-*.jsonl` | 每完成一次模型往返追加一条（运行中的实时轮次） |
| `~/.zcode/cli/log/zcode-<日期>.jsonl` | 客户端的轮次生命周期：打开的推理请求、每次工具调用、每个会话的阶段 |
| `~/.zcode/v2/tasks-index.sqlite` | 任务标题、每任务状态、Automations 与空闲时段任务 |

对 Agent 来说，同一个视图就是 `zcode_runs` 这个 MCP 工具：一次调用就能看到"正在跑什么、此刻在做什么、刚跑完什么"，是盯着长任务交接的实用方式。面板打开时每 15 秒刷新一次。

这也让长任务敢交出去：一个高强度思考的轮次可能超过调用方自己的等待上限 —— 调用返回超时，客户端还在继续干 —— 而这次运行仍然可见，不会随着调用一起消失。

## 它出现在哪：右侧栏的一个标签页

面板不是一个"要自己去找的页面"。插件自带**客户端半边**，把它注册成 DSH 右侧栏里与 Subagents、Tasks 并列的标签页；设置 → 插件 → ZCode 里那个开关决定它的去留（按浏览器保存，默认开）。

这个标签页由 DSH 自己的三个扩展点组成：

| 组成 | 注册到 | 说明 |
|---|---|---|
| 标签类型 | `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` | 自己占一个 `kind`，不会和 Files/Tasks 撞车；`guide` 胶囊是它在右侧栏列表里的入口 |
| 正文 | 槽位 `sidebar.right.pane.tab`，用同一个 id 作 key | 正文是宿主路由的 `iframe` —— 视图只有一份实现，不重复写第二套 UI |
| 标题 chip | 槽位 `sidebar.right.pane.tab.title`，同一个 id | 图标 + 由框架传入的标题 |

同样的形状适用于任何想在右栏加面板的 DSH 插件；`lib/client.js` 是**预先构建好的 bundle**（无需打包器，它本身就在 `__ModuleLoader__.load` 外壳里）。

## 三个路由

| 路由 | 内容 |
|---|---|
| `GET /plugins/dsh-zcode-connect/status` | JSON 快照（面板与脚本都用它） |
| `GET /plugins/dsh-zcode-connect/panel` | 自包含 HTML 面板（无构建步骤、无 React） |
| `POST /plugins/dsh-zcode-connect/bridge/start` | 按需拉起 GUI 桥（`bridgeMode: on-demand` 时用） |

三条都是**仅回环**：`request.socket.remoteAddress` 必须是 loopback，否则 403；起进程那条还只接受 POST。

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
2. **窗口位置和大小随便** —— 桥从不读、不移动、不缩放操作系统窗口，它 attach 的是窗口里的渲染进程页面。一次请求期间，页面的布局视口被冻结在窗口**当前**尺寸与 dpr 上（避免"量坐标→点击"之间目标漂移），请求结束即释放 —— 这是每次请求的冻结，不是改你的窗口。
3. 插件自身**只读**：不发消息、不点按钮、不改客户端配置，因此不会消耗额度。
4. 面板要读套餐接口，需要账号 token 未过期；过期时 `grant.errors` 会原样显示。
5. 状态有 15 秒缓存（`cacheMs`），避免频繁打套餐接口。
6. 余额是**周末活动额度**，`expires_at` 到了就归零；它按天重置，面板显示的永远是当前可用。
7. 高思考强度的一轮可能比调用方自己的等待上限还长：调用方会拿到超时，客户端仍在继续干。这时用 `zcode_runs` 或面板看那次运行 —— 它不会因为调用超时而消失。
8. **桥是独立进程，由本插件托管**：`bridgeMode` 决定它是按需启动（默认）、随插件加载启动，还是完全不管；已经在跑的桥会被复用，**不是自己起的桥绝不停掉**。

## 配置

```yaml
- id: zcode-connect
  name: dsh-zcode-connect
  config:
    debugPort: 9333          # ZCode 的远程调试端口
    bridgePort: 9444         # bridge/zcode-bridge.mjs 的健康端口
    bridgeMode: on-demand    # on-demand（默认）| auto | off —— 见上一条
    cacheMs: 15000
    # catalogPath: <可选> 客户端内置目录，用于列出"已知模板"数量
    # bridgeScript: <可选> 要拉起的桥脚本；留空表示用插件自带那份
```

## 安装与挂载

1. `profiles/web/package.json`：`dependencies` 加
   `"dsh-zcode-connect": "link:%USERPROFILE%/.dsh/vendor-plugins/dsh-zcode-connect"`，
   `dsh.profile.bundles` 加 `"dsh-zcode-connect"`
2. 依赖桥：`<插件>/node_modules/@deepseek-ai` → junction 到
   `%USERPROFILE%/.dsh/profiles/node_modules/@deepseek-ai`
3. **重启宿主**后生效

> **客户端半边是 fail-closed 的：不要"半声明"。** `package.json` 声明了 `exports["./client"]` 与
> `dsh.client`，那么 `lib/client.js` **必须存在**。DSH 在启动时合成客户端 bundle，一旦声明解析不到
> 文件就抛 `ClientPackageCompositionError` —— 不是跳过这个插件，而是**整个 harness 拒绝启动**
> （实测表现：启动器把 dsh 拉起来，约 5 秒后自己退出）。两者必须同进同退：要删 `lib/client.js`，
> 就在同一个提交里把这两处声明一起删掉。


## MCP 服务器（`mcp/server.mjs`）

同一个包里带一个零依赖的 MCP stdio 服务器（手写 JSON-RPC，换行分隔），DSH 通过
`@deepseek-ai/dsh-mcp-client` 消费它，工具名会变成 `mcp__zcode__*`：

| 工具 | 作用 | 是否花额度 |
|---|---|---|
| `zcode_status` | 套餐 / 实时余额 / 客户端已装载通道 | 否（只读） |
| `zcode_runs` | 客户端后台此刻在跑什么、刚跑完什么（subagent / 任务 / 定时与空闲任务） | 否（只读） |
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

这两条并行的工作线程**在跑的当下就能在面板里看到**（角色、任务、正在执行的工具与目标、轮次、tokens），跑完各自带出 `outcome / counts / CHANGED` —— 见上面的"后台与 subagent 的运行状况"。

### 循环 / 定时（原生能力，不必自己造）

ZCode 自带：**Automations → 定时任务**（可选每任务模型与思考强度）与 **Idle-time task**（无排期，空闲时排队跑，**免费**）。
Agent 工具面里还有 `CronCreate` / `CronList` / `CronDelete` / `Monitor` / `ScheduleWakeup`，
所以"让它自己跑 24 小时"可以直接用 prompt 让它建 cron，不需要外部循环。

## 把 MCP 装到 DSH

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

前提：ZCode 带 `--remote-debugging-port=9333` 在跑，且桥在 9444 上（`bridgeMode: on-demand` 时，第一次
`zcode_ask` 会自己把它拉起来）。缺哪个，`zcode_ask` 的报错就会点名哪一个（不会静默失败）。

## 自检

```powershell
node test/verify.mjs          # 宿主半边：导出面 / 三个路由 / 回环校验 / 真实快照 / 无 token 泄漏
                              # + 后台运行记录解析（合成客户端目录）
                              # + 桥的生命周期（真起一个进程再停掉）
node test/client-bundle.mjs   # 客户端半边：按 DSH 的方式加载 bundle，校验标签页契约与开关
```

## 面板形态

面板是一张**自包含 HTML 页**（`/plugins/dsh-zcode-connect/panel`）：零构建步骤、零前端依赖，浏览器里能直接开。
而在 DSH 内部，它由客户端半边注册成**右侧栏的一个标签页**（与 Subagents / Tasks 并列），开关在
设置 → 插件 → ZCode 里；标签正文就是这个路由的 iframe。
