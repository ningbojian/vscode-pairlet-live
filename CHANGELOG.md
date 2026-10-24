# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式。

## [Unreleased]

## [0.1.0] - 2026-10-24

### Added

- **项目级合并直播视图**：同一项目的所有会话合并成一条按时间排序的时间线，列表里每个项目
  只占一行（显示会话数量与聚合徽标），不再需要在上百条会话里猜该点哪一个。
  - 共享历史（`--resume`/手机新会话复制过来的条目）按 JSONL `uuid` 在**条目级**去重，只显示一次；
    分支之后的消息全部保留。
  - 用户消息标注来源会话（手机端带 📱），不同会话用 4 种主题色区分；工具活动不跨会话合并。
  - 合并视图为每个会话读取末尾 2MB、最多最近 8 个会话；此模式不做向上翻页。
  - 单会话项目仍保留原 512KB 向上分块翻页。
- ⏸ 等待确认与手机活动在项目维度聚合：任一成员会话等待即显示项目徽标；合并视图状态条
  取最近写入的等待中会话。
- 直播视图**工具活动折叠**：连续的 `tool_use` / `tool_result` 收进一个默认收起的
  「⚙ 工具活动 · N 项」组，点击展开看单条命令/结果摘要；实时追加的工具并入同一组，
  不再逐条占行刷屏。
- 「手机活动」检测：TSV 中新出现且已写入消息的手机会话，默认自动切换直播视图
  （`pairletLive.autoOpenNewPhoneSession`）；关闭后改为面板顶部提示条。
- 已有手机会话在后台产生新输出时显示「手机会话有新消息」提示条，不自动切换；点开后重新武装。
- 首次扫描只建立基线，不会因为已存在的历史手机会话抢走当前视图。

### Changed

- 会话列表由「项目组头 + 会话行」改为「每项目一行」；点击行打开该项目的合并视图，
  手机提示条/通知也按项目打开。
- `check:ci` 增加 `check:merge`；`check:grouping`/`check:boot` 覆盖项目级列表与合并视图。

### Fixed

- 手机端在**新会话**里发送 Prompt 时，面板只显示 VS Code 当前会话、看不到手机消息的问题。
- 宿主主动打开会话（通知「查看」/自动切换）时，webview 现在会同步打开的项目与会话焦点。
- 安装文档中的扩展目录名改为 VS Code 实际使用的 `<publisher>.<name>-<version>`
  （如 `ningbojian.pairlet-live-0.1.0`）。

## [0.0.1] - 2026-10-24

### Added

- 只读直播 `~/.claude/projects/**/*.jsonl`，不写入、不启动进程、不发起网络请求。
- 会话列表：按项目分组、48 小时优先、最多 30 条、活跃 / 手机 / 等待确认徽标。
- 直播视图：用户/助手/工具/系统消息，自动滚动与新消息芯片。
- 大会话 512KB 尾部窗口 + 向上滚动懒加载更早记录。
- 工具调用与结果的 140 字符摘要（可展开）。
- 事务内文件路径识别与点击跳转（仅允许会话 `cwd` 或当前工作区内的文件）。
- 手机会话归属：只读 `~/.cc-pocket/spawned-sessions.tsv`。
- 手机会话新消息自动显示（`pairletLive.autoReveal`）。
- ⏸ 等待确认检测：未决 `tool_use` + 静止 ≥20 秒 + 最新项为未决工具调用。
- 手机会话等待确认通知（`pairletLive.notifyWaiting`）。
- 开发自检脚本：transcript / tailer / phone / paths / paging / grouping / pending / webview boot。
- README、安装说明、兼容性契约、上游贡献策略、CI。

[Unreleased]: https://github.com/ningbojian/vscode-pairlet-live/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ningbojian/vscode-pairlet-live/releases/tag/v0.1.0
