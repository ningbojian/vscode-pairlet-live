# Pairlet Live

一个 **只读** 的 VS Code 侧边栏扩展：实时直播手机端（Pairlet）驱动的 Claude Code 会话。

> 代码仓库：[github.com/ningbojian/vscode-pairlet-live](https://github.com/ningbojian/vscode-pairlet-live)

> **非官方社区项目。** 本项目与 [heypandax/pairlet](https://github.com/heypandax/pairlet)
> 无隶属关系，也未获其背书；Pairlet 名称与商标归其作者所有。
>
> 为什么需要它：上游 [issue #70](https://github.com/heypandax/pairlet/issues/70) 说明，
> 存活中的手机驱动会话会被 Claude Code 的 VS Code 扩展与 `--resume` 选择器隐藏
> （`entrypoint:"sdk-cli"`），但转录文件从第一秒起就在共享目录。本扩展只做一件事：
> 在 IDE 内零配置、只读地看见这些会话。

它从 `~/.claude/projects/<project-slug>/<sessionId>.jsonl` 读取共享转录文件，在活动栏的
**Pairlet Live** 面板里实时渲染；手机会话的归属来自 `~/.cc-pocket/spawned-sessions.tsv`。

> 输入请在手机 App 或 VS Code 原生扩展中进行。本扩展从不写入转录、从不启动 claude、
> 从不注入输入，也没有任何网络请求与遥测。

安装细节见 [INSTALL.md](INSTALL.md)。

---

## 与上游桌面端的分工

| 面 | 职责 |
| --- | --- |
| Pairlet 官方 App / 桌面端 | 完整控制面：Watch / Approve / Continue / Inspect、diff、通知、跨设备配对 |
| 本扩展 | VS Code 内的**零配置、只读、零网络**直播；不发送输入、不审批、不写转录 |

本扩展不是官方桌面端的替代品。如果你需要批准、接管或查看 diff，请使用官方 App/桌面端。
本扩展的独特价值是：在会话仍然存活、原生 VS Code 扩展还看不到它的时候，提供 IDE 内可见性。

---

## 功能一览

### 会话列表

- 扫描 `~/.claude/projects` 下的全部会话（不限于当前工作区）。
- 按项目分组：组头是项目文件夹名（悬停看完整路径），组内按最近更新倒序，组间按组内最新活跃排序。
- 48 小时内有更新的会话排前面；总是最多显示 **30 条**。
- 徽标：`📱 手机`（Pairlet 守护进程拉起的会话）、`活跃`（60 秒内写入）、
  `48 小时内`、`⏸ 等待确认`。
- 「↻ 刷新」手动重扫；列表每 10 秒自动更新。

### 直播视图

- 用户输入（蓝色左边框）、助手回复、工具活动、系统提示。
- **连续的工具调用与结果折叠成一行**「⚙ 工具活动 · N 项：Bash, Read…」，默认收起；
  点击展开可看每条命令/结果摘要，避免工具刷屏冲掉助手正文。实时追加的工具会并入
  同一组（组仍保持你上次的收起/展开状态）。
- 文件被追加时自动滚动到底部；向上翻看时出现「新消息 (n) ↓」芯片。
- 超过 512KB 的会话只加载文件末尾窗口；滚动到顶部时按 512KB 向前懒加载历史，
  保持视口不跳动，到达文件开头显示「已到开头」。
- 消息中的文件路径（`src/extension.ts:42`、`C:\path\file.ts`、`./media/main.js`）
  带下划线，可点击在编辑器中打开并跳转到行；出于安全只允许打开会话 `cwd` 或当前工作区内的文件。

### 手机会话识别与自动显示

- Pairlet 守护进程在 `%USERPROFILE%\.cc-pocket\spawned-sessions.tsv` 追加
  `<项目绝对路径>\t<会话ID>`，扩展只读该文件；文件缺失按「没有手机会话」处理。
- 当前正在直播的**手机会话**收到新行时，自动展开并聚焦面板一次；桌面/扩展驱动的会话永不触发。
- 如果手机在**另一个会话**（新建或已有）里产生输出，而当前正在看别的会话：
  - 新手机会话 + `pairletLive.autoOpenNewPhoneSession`（默认 `true`）→ 自动切换到新会话并聚焦面板；
  - 新手机会话 + 该设置关闭 → 顶部显示「📱 新的手机会话：<项目> · <会话ID> — 点击查看」；
  - 已有手机会话产生新输出 → 顶部显示「📱 手机会话有新消息：… — 点击查看」，不自动切换，避免打断当前阅读。
- 首次打开面板只建立基线，不会因为已存在的历史手机会话而抢走当前视图；在会话列表里时也不会自动切换。
- 同一会话的提示只会出现一次；点开后重新武装，离开后再次有手机输出会再次提示。

### ⏸ 等待确认

判定条件：存在没有对应 `tool_result` 的 `tool_use`，转录文件已静止 ≥ 20 秒，
且最新一条就是这个未决的 `tool_use`。

- 面板底部显示「⏸ 等待确认：<工具名>」状态条。
- 列表里的会话显示 `⏸ 等待确认` 徽标（只读文件末尾 16KB 做尽力而为检测）。
- **手机会话**从非等待转为等待时，弹一次 VS Code 通知，附「查看」按钮；
  同一轮等待期间不重复通知，解除后重新武装。

### 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `pairletLive.autoReveal` | `true` | 手机会话有新消息时自动显示并聚焦面板；桌面会话永不触发。 |
| `pairletLive.autoOpenNewPhoneSession` | `true` | 新的手机会话出现时自动切换直播视图；关闭后改为顶部提示条。已有手机会话产生新输出时只显示提示条，不会自动切换。仅在 `autoReveal` 开启时生效。 |
| `pairletLive.notifyWaiting` | `true` | 手机端等待确认时弹一次通知；面板状态条与列表徽标不受影响。 |

---

## 安装

### 方式一：开发调试（推荐先用这个验证）

```bat
npm install
npm run compile
```

用 VS Code 打开本文件夹，按 `F5` 启动「扩展开发宿主」窗口，在新窗口活动栏点击
**Pairlet Live** 图标。修改代码后按 `Ctrl+R` 重载调试窗口。

> 仓库已附 [.vscode/launch.json](.vscode/launch.json) 与 [.vscode/tasks.json](.vscode/tasks.json)，
> `F5` 会先执行 `npm: compile` 再启动扩展宿主。

### 方式二：安装到本地日常使用

```bat
npm install
npm run compile
xcopy /E /I "C:\Users\Lenovo\Desktop\job\repos\vscode-pairlet-live" "%USERPROFILE%\.vscode\extensions\ningbojian.pairlet-live-0.0.1"
```

文件夹名必须是 `<publisher>.<name>-<version>` 格式（`publisher: "ningbojian"` + `name: "pairlet-live"` → `ningbojian.pairlet-live-0.0.1`）。
复制时可以不带 `node_modules/`、`src/`、`scripts/`、`*.map`——运行时只需要 `package.json`、
`out/*.js` 和 `media/`。

然后 `Ctrl+Shift+P` → `Developer: Reload Window`，点击活动栏的 **Pairlet Live** 图标。

卸载：删除 `%USERPROFILE%\.vscode\extensions\ningbojian.pairlet-live-0.0.1` 后重载窗口。

---

## 工作原理

```
~/.claude/projects/**/*.jsonl
        │  readTail(512KB) / readOlderChunk(512KB) / fs.watch
        ▼
src/tailer.ts ──► src/transcript.ts ──► src/pending.ts
        │              (JSONL → RenderItem)      (未决 tool_use + 静止时长)
        ▼
src/extension.ts (WebviewViewProvider, 10s 扫描, 手机提醒)
        │  postMessage: sessions / streamStart / streamAppend / olderChunk / pendingState
        ▼
media/main.js + paging.js + grouping.js + pathlinks.js + style.css
```

| 文件 | 职责 |
| --- | --- |
| `src/extension.ts` | 扩展入口；会话扫描、Webview 生命周期、消息协议、路径校验、通知与自动显示。 |
| `src/tailer.ts` | 只读 tail：初始末尾窗口、向前分块读取、`fs.watch` 实时增量（失败回退 2s 轮询）。 |
| `src/transcript.ts` | 容错 JSONL 解析，产出 `RenderItem`；统计消息数 / `cwd` / `sessionId`。 |
| `src/pending.ts` | ⏸ 等待确认检测、一次性状态跃迁跟踪、通知门控。 |
| `src/phone.ts` | 解析手机会话 TSV，缺失或损坏时安全降级。 |
| `media/main.js` | Webview UI：列表、直播、滚动翻页、新消息芯片、路径点击。 |
| `media/paging.js` / `grouping.js` / `pathlinks.js` | 无 DOM 的纯函数模块，被 Webview 和 Node 自检共用。 |
| `scripts/check-*.mjs` | 自检脚本（见下）。 |

设计上的两条硬约束：

1. **只读**：不写转录、不启动进程、不注入输入。
2. **零运行时依赖 / 零网络**：只用 VS Code API + Node 内置模块；Webview 内容全部用
   `textContent` 渲染，CSP 带 nonce，不碰 `innerHTML`。

---

## 开发与自检

```bat
npm run compile        :: TypeScript 编译到 out/
npm run watch          :: 增量编译
```

| 命令 | 覆盖内容 |
| --- | --- |
| `npm run check` | 用本机真实转录跑解析器，输出条数统计（不输出内容）。 |
| `npm run check:tailer` | 部分行交接、初始加载竞态、截断标记。 |
| `npm run check:phone` | TSV 解析、真实文件归属、缺失/损坏降级。 |
| `npm run check:paths` | 路径正则的合成用例 + 真实转录计数扫描。 |
| `npm run check:paging` | 分块边界数学（含 1KB–1.3MB 大记录）、不重复请求、到底状态。 |
| `npm run check:grouping` | 分组排序与路径原样透传。 |
| `npm run check:pending` | 未决工具检测、政策跃迁/重新武装、通知门控。 |
| `npm run check:boot` | 在 Node vm + 最小 DOM 垫片中启动真实 `media/main.js`，验证列表/翻页/返回/状态条/工具折叠。 |
| `npm run check:ci` | CI 用的自包含组合：tailer + paging + grouping + pending + boot（不依赖真实 `~/.claude`）。 |

> `check:paths` 会扫描最新的真实转录；在 110MB 级文件上可能非常慢（见「已知限制」）。
> 依赖的真实文件格式与升级影响见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)；
> 上游贡献与发布策略见 [docs/UPSTREAM-STRATEGY.md](docs/UPSTREAM-STRATEGY.md)。

---

## 已知限制与欠缺功能

### P0 — 影响日常阅读体验

1. **不渲染 Markdown**：助手回复按纯文本显示，`**粗体**`、列表、表格、代码围栏都以原文出现，
   代码没有语法高亮。这是与原生 Claude Code 面板差距最大的一项。
2. **看不到完整工具输入/输出**：`tool_result` 和 `tool_use` 只保留 140 字符摘要，
   展开后仍是同一份截断文本；无法查看完整命令输出、diff、文件内容。
3. **用户消息截断在 4000 字符**，没有「查看全文」；`thinking` 块完全隐藏且无法切换显示。
4. **面板未打开时收不到任何提醒**：扩展靠 `onView` 隐式激活，轮询定时器在
   `resolveWebviewView` 里才启动。新开 VS Code 窗口后如果没点过图标，手机等待确认不会通知。
   建议加 `onStartupFinished` 激活事件并把定时器/通知移到激活阶段。

### P1 — 功能缺口

5. **会话列表能力有限**：固定 30 条、无搜索/项目过滤/「显示全部」，超出部分无法查看；
   也没有收藏、标记已读、清空或未读计数。
6. **没有命令面板 / 快捷键 / 状态栏入口**：无法用命令直接打开面板或跳转到某个会话。
7. **通知只覆盖手机端「等待确认」**：桌面会话的等待、任务完成、错误都没有提醒；
   也没有「是否通知桌面会话」的设置项。
8. **多窗口会重复通知**：每个已解析过面板的 VS Code 窗口都会独立扫描同一份转录并各自通知，没有去重。
9. **自动切换只覆盖“新出现的手机会话”**：已有手机会话继续输出时只显示顶部提示条，不会自动切换；
   需要点击提示条或手动在列表里点开。`pairletLive.autoOpenNewPhoneSession` 控制新会话是否自动切换。
10. **没有「在原生 Claude Code 中打开」入口**，只读定位下缺少一个自然的继续操作出口。
11. **无消息内搜索、复制/导出**；不能把一段会话导出为 Markdown。
12. **图片/附件不显示**：`attachment` 类型被直接忽略。

### P2 — 工程与发布

13. **VSIX 可本地打包，但还没有市场发布链路**：`vsce` 未作为 devDependency，
    缺 128×128 市场图标；`publisher` 已改为 `ningbojian`，`repository` / `bugs` / `homepage`
    已指向 GitHub，但尚未创建 Marketplace publisher / Release。
14. **没有标准测试框架与 CI**：自检脚本是手工 `npm run`，部分依赖本机 `~/.claude` 真实数据；
    建议把纯函数测试迁到 Vitest，真实数据检查标记为可选。
15. **`check:paths` 在超大转录上极慢**：110MB 文件上超过 5 分钟未结束（疑似正则在大行上回溯），
    建议只抽样或限制单行长度后再测。
16. **无输出通道/日志**：文件读取失败大多被静默吞掉，排障只能看代码。建议加一个
    `OutputChannel`（`Pairlet Live`）。
17. **无国际化**：界面与通知全部硬编码中文。
18. **大文件性能**：列表刷新时对 ≤8MB 的会话全量读取并 JSON 解析（每 10 秒、mtime 变化时），
    并对存储内所有 `.jsonl` 各读 16KB 做 ⏸ 检测；会话很多时开销可观。`metaCache` 也没有淘汰机制。
19. **平台覆盖偏 Windows**：slug 反解在 POSIX 路径上是有损的；没有 Mac/Linux/Remote-SSH/WSL
    的验证与说明（扩展读取的是扩展宿主所在机器的 `~/.claude`，Remote-SSH 需装到远端）。
20. **路径与配置硬编码**：`~/.claude/projects`、`~/.cc-pocket/spawned-sessions.tsv` 都不可配置，
    `SESSION_CAP` / `RECENT_MS` / `CHUNK_BYTES` 也都是常量。
21. **可访问性与主题**：部分颜色（蓝色用户边框、绿色徽标）是硬编码值，缺少 ARIA 标注，
    高对比度主题下可能对比度不足。

### 有意为之的「缺失」

以下不是缺陷，而是设计边界：

- 不能发送输入、不能中断/继续任务、不能修改会话；
- 不能删除或重命名会话文件；
- 不启动 `claude`、不代理网络、不做遥测。

---

## 安全与隐私

- 只读打开 `~/.claude/projects/**/*.jsonl`；`open` 消息里的路径会被校验必须位于该目录下。
- 点击消息内路径时，只允许打开「会话 `cwd` ∪ 当前工作区」内的真实文件，Windows 下大小写不敏感。
- Webview 使用 nonce CSP，所有内容通过 `textContent` 写入，不使用 `innerHTML`。
- 不产生网络请求；不上传任何转录内容。

## License

MIT，见 [LICENSE](LICENSE)。
