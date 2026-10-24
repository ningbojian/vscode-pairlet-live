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

  /**
   * Collapse a session list into ONE row per project (the list's primary unit).
   * Grouping key is `projectDir` (the slug directory — unique even when the
   * lossy decoded labels of two sessions differ). Returns:
   *   { projectDir, label, basename, sessions, latest, count,
   *     phone, pending, active, recent, latestSessionId }
   * Sessions inside a project stay sorted by mtime desc; projects by latest desc.
   */
  function groupProjects(sessions) {
    var list = Array.isArray(sessions) ? sessions : [];
    var byDir = new Map();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) {
        continue;
      }
      var key =
        typeof s.projectDir === "string" && s.projectDir !== ""
          ? s.projectDir
          : typeof s.projectLabel === "string"
            ? s.projectLabel
            : "";
      if (!byDir.has(key)) {
        byDir.set(key, []);
      }
      byDir.get(key).push(s);
    }
    var groups = [];
    byDir.forEach(function (items, key) {
      items.sort(function (a, b) {
        return (b.mtimeMs || 0) - (a.mtimeMs || 0);
      });
      // Prefer the most frequent non-empty label (exact cwd usually repeats);
      // ties go to the longer string (restores spaces from the lossy slug).
      var counts = new Map();
      for (var j = 0; j < items.length; j++) {
        var l = typeof items[j].projectLabel === "string" && items[j].projectLabel !== "" ? items[j].projectLabel : "";
        if (l) {
          counts.set(l, (counts.get(l) || 0) + 1);
        }
      }
      var label = "";
      var bestCount = -1;
      counts.forEach(function (c, l) {
        if (c > bestCount || (c === bestCount && l.length > label.length)) {
          bestCount = c;
          label = l;
        }
      });
      if (!label) {
        label = key;
      }
      groups.push({
        projectDir: typeof items[0].projectDir === "string" ? items[0].projectDir : "",
        label: label,
        basename: basename(label),
        sessions: items,
        latest: items.length > 0 ? items[0].mtimeMs || 0 : 0,
        count: items.length,
        phone: items.some(function (x) {
          return !!x.phone;
        }),
        pending: items.some(function (x) {
          return !!x.pending;
        }),
        active: items.some(function (x) {
          return !!x.active;
        }),
        recent: items.some(function (x) {
          return !!x.recent;
        }),
        latestSessionId: items[0].sessionId || ""
      });
    });
    groups.sort(function (a, b) {
      return b.latest - a.latest;
    });
    return groups;
  }

  window.PairletListGrouping = { basename: basename, groupSessions: groupSessions, groupProjects: groupProjects };
})();
