// media/grouping.js — pure project-grouping for the session list.
// No DOM access: loaded by media/main.js in the webview and exercised by
// scripts/check-grouping.mjs in a Node vm sandbox (fake window).
// Labels are passed through UNTOUCHED — callers must render them with
// textContent only (project paths can contain arbitrary characters).
"use strict";

(function () {
  /** Last path segment; handles Windows and POSIX separators, trailing seps. */
  function basename(p) {
    if (typeof p !== "string" || p === "") {
      return "";
    }
    var norm = p.replace(/[\\/]+$/, "");
    if (norm === "") {
      return p; // path was all separators
    }
    var idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
    return idx >= 0 ? norm.slice(idx + 1) : norm;
  }

  /**
   * Group sessions by project label.
   * Returns [{ label, basename, sessions, latest }]:
   *  - sessions inside each group sorted by mtime desc (most recent first)
   *  - groups ordered by most-recent-session activity (latest mtime) desc
   * The label string is returned verbatim (render via textContent).
   */
  function groupSessions(sessions) {
    var byLabel = new Map();
    var list = Array.isArray(sessions) ? sessions : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) {
        continue;
      }
      var label = typeof s.projectLabel === "string" && s.projectLabel !== "" ? s.projectLabel : s.projectDir || "";
      if (!byLabel.has(label)) {
        byLabel.set(label, []);
      }
      byLabel.get(label).push(s);
    }
    var groups = [];
    byLabel.forEach(function (items, label) {
      items.sort(function (a, b) {
        return (b.mtimeMs || 0) - (a.mtimeMs || 0);
      });
      groups.push({
        label: label,
        basename: basename(label),
        sessions: items,
        latest: items.length > 0 ? items[0].mtimeMs || 0 : 0
      });
    });
    groups.sort(function (a, b) {
      return b.latest - a.latest;
    });
    return groups;
  }

  window.PairletListGrouping = { basename: basename, groupSessions: groupSessions };
})();
