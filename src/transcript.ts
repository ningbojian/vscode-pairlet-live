/**
 * transcript.ts — tolerant JSONL parser for ~/.claude/projects/<slug>/<sessionId>.jsonl
 *
 * READ-ONLY: this module only parses strings. It never writes, never spawns.
 *
 * Schema notes (learned from real files on this machine, 2026-10):
 * - Line types seen: user, assistant, system, queue-operation, attachment,
 *   atis-latch, last-prompt, api-request, api-request-shape, api-request-blob,
 *   ai-title, file-history-snapshot, file-history-delta, mode, permission-mode,
 *   agent-name.
 * - user/assistant entries have a `message` object with `content` that is either
 *   a plain string, or an array of blocks: {type:"text"|"thinking"|"tool_use"|"tool_result",...}.
 * - tool_result blocks live inside `type:"user"` entries.
 * - Unknown types/blocks must never crash rendering.
 */

export type ItemKind = "user" | "assistant" | "thinking" | "tool" | "system" | "unknown";

export interface RenderItem {
  kind: ItemKind;
  /** Primary text (user input, assistant text, system content, thinking). */
  text?: string;
  /** Tool name for kind==="tool" (e.g. "Bash", "Read"). */
  toolName?: string;
  /** One-line summary of tool input (kind==="tool") or result marker. */
  brief?: string;
  /** ISO timestamp if present on the entry. */
  timestamp?: string;
  /** For kind==="unknown": the unrecognized type / marker, for a fallback line. */
  fallbackType?: string;
  /** True for tool_result-sourced items (kind==="tool"). */
  isResult?: boolean;
  /** tool_use block `id` (kind==="tool", !isResult) — used to match results. */
  toolId?: string;
  /** tool_result block `tool_use_id` (kind==="tool", isResult). */
  toolUseId?: string;
}

/** Internal noise types: present in real transcripts, not user-visible conversation. */
export const IGNORED_TYPES = new Set([
  "queue-operation",
  "attachment",
  "atis-latch",
  "last-prompt",
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "ai-title",
  "file-history-snapshot",
  "file-history-delta",
  "mode",
  "permission-mode",
  "agent-name"
]);

const MAX_TEXT = 4000;
const MAX_BRIEF = 140;

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max) + "…（已截断）";
}

function asText(v: unknown): string | undefined {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return undefined;
}

/** Summarize a tool_use `input` object into a short one-liner. */
export function briefInput(input: unknown): string {
  if (input == null || typeof input !== "object") {
    const s = asText(input);
    return s ? truncate(s, MAX_BRIEF) : "";
  }
  const obj = input as Record<string, unknown>;
  const interesting = [
    "command",
    "description",
    "prompt",
    "skill",
    "pattern",
    "path",
    "file_path",
    "notebook_path",
    "url",
    "query",
    "old_string",
    "new_string",
    "content",
    "agent_type"
  ];
  const parts: string[] = [];
  for (const k of interesting) {
    const v = asText(obj[k]);
    if (v && v.trim()) {
      parts.push(`${k}=${v.trim().replace(/\s+/g, " ")}`);
    }
  }
  if (parts.length === 0) {
    try {
      return truncate(JSON.stringify(obj), MAX_BRIEF);
    } catch {
      return "";
    }
  }
  return truncate(parts.join("  ·  "), MAX_BRIEF);
}

/** Summarize a tool_result `content` (string or array of {type,text,...} blocks). */
export function briefResult(content: unknown): string {
  if (typeof content === "string") {
    return truncate(content.replace(/\s+/g, " ").trim(), MAX_BRIEF);
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        const t = asText((b as Record<string, unknown>).text);
        if (t) {
          texts.push(t);
        }
      } else {
        const t = asText(b);
        if (t) {
          texts.push(t);
        }
      }
    }
    if (texts.length === 0) {
      return "";
    }
    return truncate(texts.join(" ").replace(/\s+/g, " ").trim(), MAX_BRIEF);
  }
  const s = asText(content);
  return s ? truncate(s, MAX_BRIEF) : "";
}

function systemText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() ? truncate(content, MAX_TEXT) : undefined;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        const t = asText((b as Record<string, unknown>).text);
        if (t) {
          texts.push(t);
        }
      }
    }
    const joined = texts.join("\n").trim();
    return joined ? truncate(joined, MAX_TEXT) : undefined;
  }
  return undefined;
}

/**
 * Parse one JSONL line into zero or more render items.
 * Never throws: unparseable lines become a single "unknown" fallback item.
 * Internal noise types yield an empty array (skipped, not shown).
 */
export function parseLine(line: string): RenderItem[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [{ kind: "unknown", fallbackType: "non-object" }];
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return [{ kind: "unknown", fallbackType: "unparseable-line" }];
  }

  const type = typeof obj.type === "string" ? obj.type : undefined;
  const timestamp = asText(obj.timestamp);
  if (type && IGNORED_TYPES.has(type)) {
    return [];
  }

  const msg = obj.message as Record<string, unknown> | undefined;
  if ((type === "user" || type === "assistant") && msg && typeof msg === "object" && !Array.isArray(msg)) {
    const kind: ItemKind = type;
    const isMeta = obj.isMeta === true;
    const content = msg.content;
    const out: RenderItem[] = [];
    if (typeof content === "string") {
      const t = content.trim();
      if (t && !isMeta) {
        out.push({ kind, text: truncate(content, MAX_TEXT), timestamp });
      }
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
          const t = asText(raw);
          if (t && t.trim() && !isMeta) {
            out.push({ kind, text: truncate(t, MAX_TEXT), timestamp });
          }
          continue;
        }
        const block = raw as Record<string, unknown>;
        const btype = typeof block.type === "string" ? block.type : "no-type";
        switch (btype) {
          case "text": {
            const t = asText(block.text);
            if (t && t.trim() && !isMeta) {
              out.push({ kind, text: truncate(t, MAX_TEXT), timestamp });
            }
            break;
          }
          case "thinking": {
            const t = asText(block.thinking) ?? asText(block.text);
            if (t && t.trim()) {
              out.push({ kind: "thinking", text: truncate(t, MAX_TEXT), timestamp });
            }
            break;
          }
          case "tool_use": {
            out.push({
              kind: "tool",
              toolName: asText(block.name) ?? "tool",
              brief: briefInput(block.input),
              timestamp,
              toolId: asText(block.id)
            });
            break;
          }
          case "tool_result": {
            out.push({
              kind: "tool",
              toolName: "结果",
              brief: briefResult(block.content),
              timestamp,
              isResult: true,
              toolUseId: asText(block.tool_use_id)
            });
            break;
          }
          default: {
            out.push({ kind: "unknown", fallbackType: `block:${btype}`, timestamp });
            break;
          }
        }
      }
    } else if (content != null) {
      if (!isMeta) {
        out.push({ kind: "unknown", fallbackType: `${type}-content:${typeof content}`, timestamp });
      }
    }
    return out;
  }

  if (type === "system") {
    const text = systemText(obj.content);
    const subtype = asText(obj.subtype);
    return [
      {
        kind: "system",
        text,
        timestamp,
        fallbackType: subtype || "system"
      }
    ];
  }

  return [{ kind: "unknown", fallbackType: type ?? "no-type", timestamp }];
}

/** Parse many lines; concatenates items from each line. Never throws. */
export function parseLines(lines: string[]): RenderItem[] {
  const out: RenderItem[] = [];
  for (const line of lines) {
    try {
      const items = parseLine(line);
      for (const it of items) {
        out.push(it);
      }
    } catch {
      out.push({ kind: "unknown", fallbackType: "parser-error" });
    }
  }
  return out;
}

export interface LineStats {
  /** Visible conversation messages (user inputs + assistant entries, excluding meta). */
  messages: number;
  /** First `cwd` field found — the exact project path (better than slug decoding). */
  cwd?: string;
  /** First `sessionId` found. */
  sessionId?: string;
}

/**
 * Count visible messages and extract cwd/sessionId while streaming lines.
 * Cheap-ish: full JSON.parse per line; callers should cache by (mtime,size).
 */
export function statsFromLines(lines: string[]): LineStats {
  let messages = 0;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed == null || typeof parsed !== "object") {
        continue;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (cwd === undefined) {
      const c = asText(obj.cwd);
      if (c) {
        cwd = c;
      }
    }
    if (sessionId === undefined) {
      const s = asText(obj.sessionId);
      if (s) {
        sessionId = s;
      }
    }
    const type = obj.type;
    if (type === "assistant") {
      messages += 1;
    } else if (type === "user" && obj.isMeta !== true) {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg && typeof msg === "object" ? msg.content : undefined;
      if (typeof content === "string") {
        if (content.trim()) {
          messages += 1;
        }
      } else if (Array.isArray(content)) {
        const hasText = content.some(
          (b) =>
            b != null &&
            typeof b === "object" &&
            (b as Record<string, unknown>).type === "text" &&
            typeof (b as Record<string, unknown>).text === "string" &&
            ((b as Record<string, unknown>).text as string).trim() !== ""
        );
        const hasToolResult = content.some(
          (b) =>
            b != null &&
            typeof b === "object" &&
            (b as Record<string, unknown>).type === "tool_result"
        );
        // A user entry that only carries tool results is not a user input.
        if (hasText || !hasToolResult) {
          messages += 1;
        }
      }
    }
  }
  return { messages, cwd, sessionId };
}
