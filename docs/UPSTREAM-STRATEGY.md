# 上游贡献策略

本文记录与 [heypandax/pairlet](https://github.com/heypandax/pairlet) 的关系定位、贡献路线和
发布前检查项。核对时间：2026-10-24。

## 1. 定位

**非官方社区项目。** 与上游无隶属关系，未获其背书。Pairlet 名称与商标归其作者所有。

与上游桌面端的分工：

| 面 | 职责 |
| --- | --- |
| Pairlet 官方 App / 桌面端 | 完整控制面：Watch / Approve / Continue / Inspect、diff、通知、跨设备配对 |
| 本扩展 | VS Code 内的**零配置、只读、零网络**直播；不发送输入、不审批、不写转录 |

本扩展不是桌面端的替代品。它的独特价值是：存活中的手机驱动会话会被 Claude Code 原生
VS Code 扩展与 `--resume` 选择器隐藏（`entrypoint:"sdk-cli"`），但转录文件从第一秒起就可读。
上游 [issue #70](https://github.com/heypandax/pairlet/issues/70) 记录了这个行为。

## 2. 上游事实（2026-10-24）

| 项 | 值 |
| --- | --- |
| 仓库 | `heypandax/pairlet`（原名 CC Pocket） |
| 许可证 | MIT；贡献即按 MIT 授权，无 CLA |
| 规模 | 149 stars / 28 forks / 14 open issues / 2 watchers |
| 最新 release | v2.6.0（2026-10-17） |
| 技术栈 | Kotlin/KMP 为主；TypeScript 仅 214 bytes |
| 架构 | `:protocol` / `:daemon` / `:relay` / `:mobile`（Compose 手机+桌面）/ `iosApp` |
| 已有桌面端 | 有，功能比本扩展全 |
| 仓库内 IDE 模块 | 无 |
| 贡献规范 | 中英文 issue/PR 欢迎；CI；`scripts/check-all.sh`；wire 兼容规则；README 中英同步 |
| 外部集成先例 | `examples/feishu-bridge/`（官方 bridge 参考实现） |
| 相关方向 | issue #151：桌面端向「环境态优先」演进（agent 需要你时主动来找你） |

## 3. 贡献路线与可行性

| 形态 | 可行性 | 说明 |
| --- | --- | --- |
| 整个扩展作为大 PR 合入主仓库 | 低 | 技术栈不匹配；引入 TS 工具链与 Marketplace 发布；维护者一人承担绝大多数提交 |
| 主仓库小 PR | 中 | 文档、`entrypoint` 边界、`pairlet sessions --json` 或只读本地 API |
| 上游 org 下的独立仓库 / 官方链接 | 中高 | 有 `examples/feishu-bridge` 先例；先 RFC，表明长期维护、MIT、可转移 |
| 完全独立社区扩展 | 高 | MIT 允许；格式变更与品牌风险自担 |
| 只发 issue 试探 | 高 | 成本最低，适合先验证 |

**推荐顺序：**

1. 发 RFC / discussion，**不要先发 PR**；
2. 以独立仓库 + 预发布 VSIX 验证需求；
3. 争取上游 README / Release 的生态链接；
4. 如果上游需要，再反向贡献一个小的稳定只读接口；
5. 只有在明确信号后才考虑审批/多后端/商业化。

## 4. 发布前必改项

当前 `package.json` 是本地开发配置，发布到 Marketplace 前必须处理：

- [ ] `publisher` 改为你自己的 Marketplace publisher ID（不要用 `pairlet`）。
- [ ] 加 `repository` / `bugs` / `homepage`，指向你的真实仓库。
- [ ] 决定名称：保留 `Pairlet Live` 需注明 Unofficial 并确认品牌使用；
      更安全的备选是中性名（如 `Agent Live View`）+ 描述「works with Pairlet」。
- [ ] `CHANGELOG.md` 的占位链接改为真实仓库地址。
- [ ] 跑 `npm run compile` 与 `npm run check:ci`。
- [ ] 用 `npx @vscode/vsce package` 打 VSIX，在干净 VS Code 中安装验证。
- [ ] README/INSTALL 的「非官方」声明与支持范围已同步。

## 5. 可直接发的 RFC 草稿

**Title:** `[Discussion] VS Code companion for live phone-driven sessions (read-only, zero-config)`

```markdown
Hi — I built a small read-only VS Code sidebar for Pairlet-driven Claude Code sessions
and would like to know whether this direction is welcome, and how you'd prefer it to live.

What it does
- Lists sessions across ~/.claude/projects, grouped by project, with phone attribution
  from ~/.cc-pocket/spawned-sessions.tsv.
- Streams live updates, shows pending tool calls, lazy-loads older history, and makes
  file paths clickable.
- Strictly read-only: no writes, no daemon spawn, no network, no telemetry.

Why
- Issue #70 explains that while a `-p`/SDK session is alive, Claude's VS Code extension
  and `claude --resume` hide it (`entrypoint:"sdk-cli"`), even though the transcript is
  already shared. This gives IDE-native visibility without switching to the desktop app.
- It complements, rather than replaces, the desktop app: the desktop app is the full
  control surface; this is the zero-setup ambient view inside VS Code.

Questions
1. Is this direction welcome?
2. Would you prefer a separate repo (possibly under the org) linked from the README,
   or a module in this repo?
3. Is there a stable read-only local interface we should use instead of the TSV/JSONL
   internals? If not, would a small `pairlet sessions --json` (or local API) be acceptable?
4. Any naming/brand constraints for an unofficial companion?

I'm happy to keep it MIT, own maintenance/releases, add CI/tests, and transfer the repo
if that helps. Not opening a PR yet — wanted to check the direction first.
```

## 6. 决策门槛

| 方向 | 启动条件 |
| --- | --- |
| 继续投入 | 上游正面回应 + 至少一个需求指标（50+ 安装 / 3+ 定性反馈 / 团队意向） |
| 只做作品集 | 上游无回复或明确不需要，且 2 周安装 < 30 |
| 官方伴侣 | 上游明确合作意向，并愿意写入 README/Release |
| 付费 Pro | 1,000+ 安装 + 10+ 团队主动询问 |
| 团队可观测性产品 | 3+ 家团队愿意试用/付费，且接受服务端部署 |

## 7. 风险

| 风险 | 应对 |
| --- | --- |
| 维护者认为桌面端已覆盖 | 强调零配置、IDE 内、只读、无凭证；接受独立社区定位 |
| 维护者自己做 VS Code 集成 | 停止重复建设，转为贡献测试/文档/协议建议 |
| 品牌/商标 | 不用 `pairlet` 作 publisher；名称加 Unofficial 或改中性名 |
| TSV/JSONL 变更 | 见 [COMPATIBILITY.md](COMPATIBILITY.md)；失败降级为空列表 |
| 维护成本 | 只做 Claude 只读视图；不接审批/多后端 |
| 安全质疑 | 零网络、零写入；CSP + textContent；路径白名单；写清威胁模型 |
