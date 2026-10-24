# 兼容性契约

本扩展是**只读观察者**，依赖两类不属于本项目的文件格式。上游没有义务保持兼容；
本文记录当前实现假设、支持的版本和失效时的表现，方便升级后排障。

> 核对时间：2026-10-24。上游：[heypandax/pairlet](https://github.com/heypandax/pairlet)。

## 1. Claude Code 转录

### 路径

```
~/.claude/projects/<project-slug>/<sessionId>.jsonl
```

- 扩展扫描整个 `~/.claude/projects`，不限于当前工作区。
- 只接受 `.jsonl` 文件；`open` 消息只允许该目录下的文件。
- `<project-slug>` 是绝对路径的非字母数字压平（如
  `C:\Users\Lenovo\Desktop\job\repos\foo` → `c--Users-Lenovo-Desktop-job-repos-foo`）。
  反解有损；优先使用转录里的 `cwd` 字段。

### 行格式

- 每行一个 JSON 对象；`type` 为 `user` / `assistant` / `system` 等。
- `user` / `assistant` 的 `message.content` 是字符串或块数组：
  `text`、`thinking`、`tool_use`、`tool_result`。
- `tool_result` 位于 `type:"user"` 的行内。
- 扩展忽略的内部类型见 `src/transcript.ts` 的 `IGNORED_TYPES`；未知类型/块不会崩溃，
  在 UI 中隐藏。
- `isMeta: true` 的 user 行不计入消息数，也不渲染。
- `cwd` / `sessionId` 取文件中第一个出现的值（通常每行都有）。
- 文本截断：消息 4000 字符，工具摘要 140 字符。

### 实时性

- 初始只读文件末尾 512KB；`readTail` 丢掉窗口起点的半行，保留完整行。
- 之后用 `fs.watch` 增量读取；失败回退 2 秒 `fs.watchFile` 轮询。
- 向上翻页按 512KB 独立只读，不干扰 tail 偏移。
- 文件被截断/轮转（`size < offset`）时从头重读。

### 已知上游行为

- 存活中的 `-p`/SDK 会话会被 Claude Code 的 VS Code 扩展和 `claude --resume`
  选择器隐藏（`entrypoint:"sdk-cli"`），但转录文件从第一秒起就可读。
  本扩展正是为这个窗口期提供 IDE 内可见性。参见上游
  [issue #70](https://github.com/heypandax/pairlet/issues/70)。
- 上游 daemon 在会话结束后会改写标记，让会话在原生选择器中显形；本扩展不依赖该改写。

## 2. 手机会话归属

### 路径

```
~/.cc-pocket/spawned-sessions.tsv
```

### 格式

```
<项目绝对路径>\t<sessionId>[\t<额外列>...]
```

- 每行一个会话；第一列是项目绝对路径，第二列是会话 ID。
- 空行、缺少 tab、空字段会被跳过；额外列忽略。
- 同一 sessionId 出现多次时，**第一行生效**。
- 文件缺失或不可读 → 视为「没有手机会话」，绝不报错。

### 用途

- 列表中的 `📱 手机` 徽标；
- `autoReveal` 自动显示，以及 `autoOpenNewPhoneSession` 新手机会话自动切换；
- 等待确认通知（只对手机端会话）。

## 3. 支持范围

| 组件 | 已验证 | 说明 |
| --- | --- | --- |
| Pairlet daemon | 2.6.0 | Windows x86_64；其他平台未人工验证 |
| Claude Code 转录 | 2026-10 格式 | 真实 110MB 转录上解析通过 |
| VS Code | ^1.85.0 | `package.json` engines |
| 操作系统 | Windows 优先 | 路径大小写/分隔符处理偏 Windows；macOS/Linux 未验证 |

## 4. 失效时的表现

| 变化 | 表现 | 影响 |
| --- | --- | --- |
| `spawned-sessions.tsv` 路径或列序变化 | 手机徽标/自动显示/新手机会话提示/通知失效，列表仍可用 | 需要更新 `src/phone.ts` |
| JSONL 新增 `type` | 该行隐藏，不崩溃 | 需要更新 `IGNORED_TYPES` 或解析分支 |
| `message.content` 块结构变化 | 该块显示为 unknown 并隐藏 | 需要更新 `src/transcript.ts` |
| slug 编码变化 | 项目名可能显示为路径片段 | 有 `cwd` 时不受影响 |
| 文件权限/被删除 | 列表跳过；已打开视图可能保留旧内容 | 需要手动返回列表刷新 |
| Claude 改变 `entrypoint` 过滤 | 原生选择器行为变化，但本扩展仍读文件 | 本扩展不受影响 |

## 5. 兼容性自检

```bat
npm run compile
npm run check          :: 真实转录解析计数
npm run check:phone    :: TSV 归属（真实文件只读）
npm run check:paths    :: 路径正则（真实转录上可能很慢）
```

升级 Pairlet 或 Claude Code 后，至少跑一次 `check` 和 `check:phone`，并手工确认：

1. 列表能发现新会话；
2. 手机徽标正确；
3. 直播能收到新行；
4. ⏸ 等待确认能出现和解除。

## 6. 非目标

- 不保证兼容所有历史版本；
- 不解析上游未公开的内部协议；
- 不写入转录、不修改 `spawned-sessions.tsv`、不调用 daemon API；
- 不承诺在格式变化后立即修复（尽力维护）。
