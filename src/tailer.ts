/**
 * tailer.ts — READ-ONLY file tailing with fs.watch (fallback: fs.watchFile poll).
 * Never writes, never spawns. Only opens files for reading.
 */

import * as fs from "fs";
import { StringDecoder } from "string_decoder";

export interface TailStart {
  /** Complete lines from the tail region of the file (ready to parse). */
  lines: string[];
  /**
   * Byte offset to continue reading from (start of the trailing partial line —
   * i.e. end of last complete line). The TranscriptTailer constructor advances
   * past the partial bytes it already carries: offset + byteLength(partial).
   */
  offset: number;
  /** Trailing bytes of an incomplete final line, carried into the tailer. */
  partial: string;
  /** Total file size at read time. */
  size: number;
  /**
   * True ONLY when the head of the file was dropped by the tail window (real
   * truncation). A small file that merely ends mid-line has truncated=false —
   * its effective read position (offset + partial length) still equals size.
   */
  truncated: boolean;
  /**
   * Byte offset where the tail WINDOW began (max(0, size - maxBytes)). This is
   * the pagination start offset: history before it can be loaded with
   * readOlderChunk(). 0 when the window covers the whole file.
   */
  windowStart: number;
}

const DEFAULT_TAIL_BYTES = 512 * 1024;

/**
 * Read the last `maxBytes` of a file and split into complete lines.
 * The final (possibly incomplete) line is returned as `partial`.
 */
export function readTail(filePath: string, maxBytes = DEFAULT_TAIL_BYTES): TailStart {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    // If we started mid-file, drop the first line — but ONLY when it is a
    // true mid-record fragment. When the byte before `start` is a newline the
    // window begins exactly on a line boundary and the first line is COMPLETE:
    // dropping it would lose a record that readOlderChunk() correctly excludes
    // (its first byte lies at/after windowStart, so it belongs to this window).
    let lines = text.split(/\r?\n/);
    if (start > 0 && lines.length > 0) {
      const one = Buffer.alloc(1);
      const got = fs.readSync(fd, one, 0, 1, start - 1);
      const alignedHead = got === 1 && one[0] === 0x0a;
      if (!alignedHead) {
        lines = lines.slice(1);
      }
    }
    const partial = lines.length > 0 && lines[lines.length - 1] === "" ? "" : (lines.pop() ?? "");
    const complete = lines.filter((l) => l.trim() !== "");
    // offset = start of the trailing partial line (end of last complete line).
    // Recompute precisely: rejoin and measure.
    let offset = size;
    if (partial !== "") {
      offset = size - Buffer.byteLength(partial, "utf8");
    }
    // Head of the file fell outside the tail window -> genuinely truncated.
    const truncated = start > 0;
    return { lines: complete, offset, partial, size, truncated, windowStart: start };
  } finally {
    fs.closeSync(fd);
  }
}

/** Bytes per lazy older-chunk read (mirrors the tail window size). */
export const CHUNK_BYTES = 512 * 1024;

export interface OlderChunk {
  /** Complete lines whose first byte lies in [newStartOffset, endOffset). */
  lines: string[];
  /** New pagination start offset (endOffset - CHUNK_BYTES, clamped at 0). */
  newStartOffset: number;
  /** True when the chunk reached the beginning of the file. */
  done: boolean;
}

/** Read exactly `length` bytes at `fileOffset` into `buf` at `bufOffset`. */
function readFully(fd: number, buf: Buffer, bufOffset: number, fileOffset: number, length: number): number {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, bufOffset + got, length - got, fileOffset + got);
    if (n <= 0) {
      break;
    }
    got += n;
  }
  return got;
}

/**
 * READ-ONLY independent read of the ~CHUNK_BYTES of history immediately
 * preceding `endOffset`. Never touches any TranscriptTailer state.
 *
 * Delivery contract (NO fixed-size overlap assumption anywhere):
 *  - A record is OWNED by the chunk in which its FIRST byte lies. A record
 *    starting in [chunkStart, boundary) — i.e. [endOffset - chunkBytes,
 *    endOffset) — is ALWAYS fully delivered by this call, regardless of size:
 *    the read window starts at the chunk head and is extended FORWARD past
 *    `endOffset` in successive chunkBytes steps until the pending tail record
 *    completes (its terminating newline is found). (A previous design used a
 *    fixed 256KB overlap past the boundary, which silently dropped any record
 *    extending further — always true for records > chunkBytes + overlap.)
 *  - Records starting at or after `endOffset` belong to the NEWER chunk and
 *    are never emitted here, even when the forward extension scanned over
 *    them (the extension stops at the first newline completing the pending
 *    record; later bytes are ignored).
 *  - The first segment of the window is dropped unless the byte before
 *    `chunkStart` is a newline (exact line boundary): a record straddling
 *    `chunkStart` is owned by the NEXT older chunk (whose endOffset equals
 *    this chunk's start) and is completed there by the same forward rule.
 *  - A trailing record with no newline even at EOF is incomplete (still being
 *    appended by the live tailer) and is dropped — never emitted partially.
 */
export function readOlderChunk(filePath: string, endOffset: number, chunkBytes = CHUNK_BYTES): OlderChunk {
  if (!Number.isFinite(endOffset) || endOffset <= 0) {
    return { lines: [], newStartOffset: 0, done: true };
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (endOffset > size) {
      // Stale offset (file rotated/truncated underneath us): no history reachable.
      return { lines: [], newStartOffset: 0, done: true };
    }
    const start = Math.max(0, endOffset - chunkBytes);
    // Read one byte before `start` to detect exact line-boundary alignment.
    const readStart = start > 0 ? start - 1 : 0;
    let readEnd = Math.min(size, endOffset);
    if (readEnd <= readStart) {
      return { lines: [], newStartOffset: start, done: start === 0 };
    }
    // Initial window: [readStart, endOffset).
    let buf = Buffer.alloc(readEnd - readStart);
    readFully(fd, buf, 0, readStart, buf.length);
    const step = Math.max(1, chunkBytes);
    // Forward extension: the trailing (newline-less) segment may be a record
    // that started before `endOffset` and continues past it — possibly by
    // megabytes. Grow the window in chunkBytes steps until that record's
    // newline lands inside it, or EOF is reached (then the final scan drops
    // the still-incomplete record).
    for (;;) {
      let lastNl = -1;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          lastNl = i;
          break;
        }
      }
      const pendingAbs = readStart + lastNl + 1; // start of trailing segment
      if (pendingAbs >= endOffset || readEnd >= size) {
        break; // nothing straddles the boundary, or EOF reached
      }
      const grow = Math.min(step, size - readEnd);
      const nb = Buffer.alloc(buf.length + grow);
      buf.copy(nb, 0);
      readFully(fd, nb, buf.length, readEnd, grow);
      buf = nb;
      readEnd += grow;
      let completed = false;
      for (let i = lastNl + 1; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          completed = true;
          break;
        }
      }
      if (completed) {
        break; // pending record finished; records after its newline stay newer-side
      }
    }
    const view = buf;
    // A line starting exactly at `start` is genuine only if the previous byte
    // is a newline; otherwise the first segment is a mid-record continuation.
    const aligned = start === 0 || view[start - 1 - readStart] === 0x0a;
    const lines: string[] = [];
    let lineStart = 0; // relative to view
    for (let i = 0; i <= view.length; i++) {
      if (i < view.length && view[i] !== 0x0a) {
        continue;
      }
      const absStart = readStart + lineStart;
      const absEnd = readStart + i; // excludes the \n itself
      const isFirstSegment = lineStart === 0;
      if (
        absStart >= start &&
        absStart < endOffset &&
        absEnd > absStart &&
        (!isFirstSegment || aligned)
      ) {
        let text = view.subarray(lineStart, i).toString("utf8");
        if (text.endsWith("\r")) {
          text = text.slice(0, -1);
        }
        if (text.trim() !== "") {
          lines.push(text);
        }
      }
      lineStart = i + 1;
    }
    // A trailing segment with no newline (incomplete at EOF) is intentionally
    // dropped — the live tailer completes and delivers it when the write ends.
    return { lines, newStartOffset: start, done: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Live-tails an append-only JSONL file. Emits batches of complete new lines.
 * Uses fs.watch; on watch errors falls back to 2s fs.watchFile polling.
 */
export class TranscriptTailer {
  private watcher: fs.FSWatcher | undefined;
  private polling = false;
  private offset: number;
  private partial: string;
  private decoder: StringDecoder | undefined;
  private stopped = false;
  private draining = false;

  constructor(
    private readonly filePath: string,
    start: TailStart,
    private readonly onLines: (lines: string[]) => void
  ) {
    // readTail's offset points at the START of the partial line and the partial
    // string is carried here. Advance past those bytes so drain() neither
    // re-reads them from disk nor double-prepends them (partial-line handoff).
    this.offset = start.offset + Buffer.byteLength(start.partial, "utf8");
    this.partial = start.partial;
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, () => {
        this.drain();
      });
      this.watcher.on("error", () => {
        this.usePolling();
      });
    } catch {
      this.usePolling();
    }
    // Drain once at the end: lines written between readTail() (caller side) and
    // watcher registration would otherwise be lost if no later write occurs.
    this.drain();
  }

  private usePolling(): void {
    if (this.polling || this.stopped) {
      return;
    }
    this.polling = true;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = undefined;
    }
    try {
      fs.watchFile(this.filePath, { interval: 2000, persistent: false }, () => {
        this.drain();
      });
    } catch {
      /* give up silently; user can re-open the session */
    }
  }

  /** Read any bytes appended since last drain; emit complete lines. */
  private drain(): void {
    if (this.draining || this.stopped) {
      return;
    }
    this.draining = true;
    try {
      let size: number;
      try {
        size = fs.statSync(this.filePath).size;
      } catch {
        return; // file vanished mid-watch; keep last state
      }
      if (size < this.offset) {
        // Truncated/rotated — restart from beginning.
        this.offset = 0;
        this.partial = "";
        this.decoder = undefined;
      }
      if (size === this.offset) {
        return;
      }
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(this.filePath, "r");
      let read = 0;
      try {
        while (read < len) {
          const n = fs.readSync(fd, buf, read, len - read, this.offset + read);
          if (n <= 0) {
            break;
          }
          read += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      this.offset += read;
      if (!this.decoder) {
        this.decoder = new StringDecoder("utf8");
      }
      const text = this.partial + this.decoder.write(buf.subarray(0, read));
      const parts = text.split(/\r?\n/);
      this.partial = parts.pop() ?? "";
      const lines = parts.filter((l) => l.trim() !== "");
      if (lines.length > 0) {
        this.onLines(lines);
      }
    } catch {
      /* never crash the extension on a transient fs error */
    } finally {
      this.draining = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = undefined;
    }
    if (this.polling) {
      try {
        fs.unwatchFile(this.filePath);
      } catch {
        /* ignore */
      }
      this.polling = false;
    }
    if (this.decoder) {
      this.decoder = undefined;
    }
  }
}
