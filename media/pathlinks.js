// media/pathlinks.js — shared file-path detection for Pairlet Live.
// Plain script (CSP nonce'd), no innerHTML anywhere: callers render the
// returned parts via textContent. Loaded before media/main.js; also exercised
// by scripts/check-pathlink.mjs in a Node vm sandbox.
"use strict";

(function () {
  /**
   * Path-like runs inside transcript text. Tuned against real transcript
   * content on this machine (see scripts/check-pathlink.mjs).
   *
   * Absolute:    C:\dir\file.ts:12  |  C:/dir/file.ts  |  \\server\share\f.md
   *              /unix/abs/file.js  |  ./rel/file.js  |  ../rel/file.js
   * Bare rel:    src/extension.ts:42   (requires at least one dir segment)
   *
   * The leading lookbehind excludes URL interiors (`https://host/a.md` — the
   * char before `host` is `/`) and mid-path fragments. Line/col suffixes
   * `:12` / `:12:5` are captured and split off by splitFilePaths.
   */
  var FILE_PATH_RE =
    /(?<![\w.:/\\])(?:[A-Za-z]:[\\/]|\\{2}|[/\\]|\.{1,2}[\\/])(?:[\w\-.\\/]+[\\/])*[\w\-.]+\.[A-Za-z0-9]{1,6}(?::\d+(?::\d+)?)?|(?<![\w.:/\\])(?:[\w\-.]+[\\/])+[\w\-.]+\.[A-Za-z0-9]{1,6}(?::\d+(?::\d+)?)?/g;

  /**
   * Split text into parts: {text} for plain runs, {text, path, line?} for
   * path runs (path excludes any :line[:col] suffix; label text === text).
   */
  function splitFilePaths(text) {
    var out = [];
    if (typeof text !== "string" || text === "") {
      return out;
    }
    var re = new RegExp(FILE_PATH_RE.source, "g"); // fresh state per call
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      var full = m[0];
      if (full.length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (m.index > last) {
        out.push({ text: text.slice(last, m.index) });
      }
      var lineMatch = /:(\d+)(?::\d+)?$/.exec(full);
      if (lineMatch) {
        out.push({
          text: full,
          path: full.slice(0, lineMatch.index),
          line: parseInt(lineMatch[1], 10)
        });
      } else {
        out.push({ text: full, path: full });
      }
      last = m.index + full.length;
    }
    if (last < text.length) {
      out.push({ text: text.slice(last) });
    }
    return out;
  }

  window.PairletPathLinks = { FILE_PATH_RE: FILE_PATH_RE, splitFilePaths: splitFilePaths };
})();
