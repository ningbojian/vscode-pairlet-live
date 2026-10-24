# Pairlet Live 安装说明

> 功能概览、架构与已知限制见 [README.md](README.md)。本文只讲安装与日常操作。
>
> **非官方社区项目**，与 [heypandax/pairlet](https://github.com/heypandax/pairlet)
> 无隶属关系；Pairlet 名称与商标归其作者所有。

一个 **只读** 的 VS Code 侧边栏扩展：直播手机端（Pairlet）驱动的 Claude Code 会话。
它从 `~/.claude/projects/<project-slug>/<sessionId>.jsonl` 读取共享的转录文件并实时渲染。

> ⚠️ 只读直播 · 输入请在手机 App 或 VS Code 原生扩展中进行。
> 本扩展从不写入转录、从不启动 claude、从不注入输入，也没有任何网络请求。

## 方式一：下载 VSIX（推荐）

1. 打开 [最新 Release](https://github.com/ningbojian/vscode-pairlet-live/releases/latest)，
   下载 `pairlet-live-0.1.0.vsix`。
2. 安装（在下载目录执行）：

   ```bat
   code --install-extension .\pairlet-live-0.1.0.vsix
   ```

   或在 VS Code 扩展视图右上角 `...` → **Install from VSIX...** 选择该文件。
3. 重新加载窗口，点击活动栏的 **Pairlet Live** 图标。

> 之前若用手工复制文件夹的方式安装过，请先执行
> `code --uninstall-extension ningbojian.pairlet-live`，再安装 VSIX。
> 同一扩展存在两个副本时会争抢 `pairletLive.view`，表现为“扩展无效/激活失败”。

## 方式二：Extension Development Host（开发调试）

1. 用 VS Code 打开本文件夹（`vscode-pairlet-live`）。
2. 按 `F5`（或菜单 运行 → 启动调试），会弹出一个「扩展开发宿主」窗口。
3. 在新窗口的活动栏中点击 **Pairlet Live** 图标（脉冲线图标）即可打开侧边栏。

修改代码后在调试窗口按 `Ctrl+R`（重新加载窗口）即可看到改动。

## 方式三：手工复制到扩展目录

1. 先编译：

   ```bat
   npm install
   npm run compile
   ```

2. 把整个文件夹复制到 VS Code 扩展目录，文件夹名必须是 `<publisher>.<name>-<version>` 格式：

   ```bat
   xcopy /E /I "C:\Users\Lenovo\Desktop\job\repos\vscode-pairlet-live" "%USERPROFILE%\.vscode\extensions\ningbojian.pairlet-live-0.1.0"
   ```

   即：把本文件夹整体复制到 `C:\Users\<你的用户名>\.vscode\extensions\ningbojian.pairlet-live-0.1.0`（在资源管理器手动复制也可以）。
   如果之后改了 `package.json` 里的 `publisher` 或 `version`，文件夹名也要同步改成新的 `<publisher>.<name>-<version>`。

3. 重新加载窗口：`Ctrl+Shift+P` → `Developer: Reload Window`（开发者：重新加载窗口）。
4. 点击活动栏的 **Pairlet Live** 图标。

> 手工复制不会写入 VS Code 的安装元数据，升级/卸载容易留下重复副本；日常使用请优先选方式一。

## 使用

- 打开侧边栏后自动列出最近的项目（宿主先取最近 30 个会话、48 小时内优先，再合并为项目行，最多 30 行）。**每个项目一行**：行内显示项目文件夹名（悬停可见完整路径）、会话数量与最近活跃时间，徽标按项目内所有会话聚合（📱 手机 / ⏸ 等待确认 / 活跃 / 48 小时内）。
- 点击一行进入该项目的**合并直播视图**：同一项目的所有会话按消息时间合成一条时间线，不需要逐个会话去猜。
  - `--resume`/手机新建会话复制过来的共享历史按 JSONL `uuid` 去重，只显示一次；分支之后的消息保留。
  - 用户消息标注来源（`用户输入 · abc12345`，手机端带 📱），不同会话用 4 种主题色区分。
  - 合并视图为每个会话读取末尾 2MB，最多合并最近 8 个会话（当前聚焦会话一定包含）；
    此模式**不做向上翻页**。
- 用户输入（左侧色条标识来源会话）、助手回复、工具活动。
- **工具活动默认折叠**：连续的命令调用与结果收进一行「⚙ 工具活动 · N 项：Bash, Read…」，点击展开看单条摘要；实时追加的工具会并入同一组（不跨会话合并）。这样大量工具不会冲掉助手正文。
- 手机端有新输出时会自动滚动到底部；向上翻看历史时会出现「新消息」提示芯片（只统计实际渲染的消息）。
- **向上翻看更早记录**：项目里只有一个会话时，超过 512KB 的大会话初次只加载文件末尾窗口。在直播视图把滚动条拉到最顶端时，会自动向宿主请求上一段约 512KB 的历史并插入「—— 更早记录 ——」分隔线上方（保持当前视口位置不跳动；请求进行中不会重复加载；到达文件开头后顶部显示「已到开头」）。分块读取是独立的只读操作，不影响实时 tail。
- 消息文本中的文件路径（如 `src/extension.ts:42`、`C:\path\to\file.ts`、`./media/main.js`）带下划线、可点击：在编辑器中打开对应文件并跳到行号。出于安全考虑，只允许打开「会话目录或当前工作区」内的文件；相对路径按会话转录里的 `cwd` 解析（无 cwd 时用第一个工作区文件夹）。
- 「↻ 刷新」按钮重新扫描会话列表；列表本身每 10 秒自动更新活跃状态（「活跃」徽标 = 60 秒内有写入）。

## 手机会话识别与自动显示（Phone auto-reveal）

- 手机会话由 Pairlet 守护进程归属：它每拉起一个会话，就在 `%USERPROFILE%\.cc-pocket\spawned-sessions.tsv` 追加一行 `<项目绝对路径>\t<会话ID>`（本扩展只读该文件；文件缺失按「没有手机会话」处理，绝不报错）。
- 会话列表扫描 `~/.claude/projects` 全量（覆盖「当前打开的工作区 ∪ TSV 里的项目路径」的并集——手机会话经常发生在未在 VS Code 打开的项目里），会话 ID 命中 TSV 的会话计入 **📱 手机** 徽标，项目名优先用 TSV 中的精确路径。
- **自动显示行为**：正在看的项目里有手机会话写入新行，且设置 `pairletLive.autoReveal`（布尔，默认 `true`）开启时——自动展开并聚焦 Pairlet Live 面板一次（同一轮输出期间不会反复弹出）。
- **新的手机会话出现在其他项目**：TSV 中新出现且已写入消息的会话，如果当前正在看另一个项目：
  - `pairletLive.autoOpenNewPhoneSession`（布尔，默认 `true`）开启 → 自动切换到该会话所属项目的合并视图并聚焦面板；
  - 关闭 → 面板顶部显示「📱 新的手机会话：<项目> · <会话ID> — 点击查看」提示条。
- **已有手机会话在其他项目产生新输出**：顶部显示「📱 手机会话有新消息：… — 点击查看」，**不会**自动切换；点开后重新武装，离开后再次有输出会再次提示。若它就在当前项目内，消息直接进入合并视图。
- 桌面/扩展驱动的会话（不在 TSV 里）**永不**触发自动显示；首次打开面板只建立基线，不会因为历史手机会话抢走当前视图；在项目列表里也不会自动切换。
- 在设置里搜索 `pairletLive.autoReveal` 或 `pairletLive.autoOpenNewPhoneSession` 可随时调整（改完立即生效，无需重载）。

## ⏠ 等待确认（pending confirmation）

判定条件（宿主侧，每次 10 秒刷新时对已解析的消息流重新评估）：存在**未匹配结果的 tool_use**（其 id 还没有对应的 tool_result），且转录文件自上次写入起已**静止 ≥ 20 秒**，且最新一条就是这个未决的 tool_use（不是正在流式输出的助手文本）。

- **面板内**：合并视图中任一正在直播的会话处于等待确认时，消息区底部显示状态条「⏸ 等待确认：<工具名列表>」（取最近写入的等待中会话；工具名去重并截断）。
- **项目列表**：项目内**任一**会话等待确认时，该行带 **⏸ 等待确认** 徽标（对列表内会话做尽力而为的尾部检测：只读文件末尾几 KB，容忍窗口边缘的残缺行；检测失败一律按「未等待」处理）。
- **通知**：当**手机会话**（ID 在 `~/.cc-pocket/spawned-sessions.tsv` 里）从非等待转为等待确认时，弹出一次 VS Code 警告「手机会话等待确认：<项目名> — <工具名>」，附「查看」按钮——点击后展开并聚焦 Pairlet Live 面板并打开该会话所属项目。通知只在**状态跃迁**时触发一次：仍在等待期间不会重复；只有在等待解除（结果返回）或该会话从列表消失后才会重新武装。
- 设置 `pairletLive.notifyWaiting`（布尔，默认 `true`）只控制这条 VS Code 通知；面板内状态条与列表 ⏸ 徽标不受影响。

## 卸载

执行 `code --uninstall-extension ningbojian.pairlet-live`，或删除
`%USERPROFILE%\.vscode\extensions\ningbojian.pairlet-live-*` 文件夹，然后 Reload Window。

## 自检（开发者）

```bat
npm run compile
npm run check
npm run check:tailer
npm run check:phone
npm run check:paths
npm run check:paging
npm run check:grouping
npm run check:merge
npm run check:pending
npm run check:boot
```

- `npm run check` 对本机一个真实的 `~/.claude/projects` 转录文件运行解析器，输出条数统计（不输出内容）。
- `npm run check:tailer` 在临时文件副本上验证部分行交接与初始加载竞态两个直播核心修复（不碰 `~/.claude`）。
- `npm run check:phone` 用 `spawned-sessions.tsv` 的临时副本验证手机会话归属逻辑（原文件只读）。
- `npm run check:paths` 验证消息内可点击路径的正则（合成用例 + 真实转录只统计数量）。
- `npm run check:paging` 在临时文件上验证滚动翻页的分块数学（跨边界记录不重复、不错位；含 1KB/300KB/900KB/1.3MB 大记录在多种对齐下的零丢失扫描——大记录无论多大都必须被拥有它的分块完整交付）与「加载中/已到底不再请求」状态机。
- `npm run check:grouping` 验证项目级列表分组（每个 `projectDir` 一行、组间按最近活跃排序、聚合徽标、多个标签时选最常用者）与路径任意字符的原样透传。
- `npm run check:merge` 验证合并时间线：`--resume` 共享历史按 `uuid` 条目级去重、分支之后的消息保留、跨会话按时间交错、缺失时间戳继承、条数上限与截断标记。
- `npm run check:pending` 验证 ⏠ 等待确认检测（未决 tool_use + 静止时长）、跃迁/重新武装逻辑与 `notifyWaiting` 门控。
- `npm run check:boot` 在 Node vm 中以最小 DOM 垫片启动真实的 `media/main.js`（连同 paging/grouping/pathlinks），验证 webview 胶水层：项目列表渲染（每项目一行/聚合徽标）、合并直播（来源标签、会话配色、禁用翻页）、单会话截断时的向上翻页、返回按钮、等待确认状态条、跨会话工具分组。
