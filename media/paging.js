// media/paging.js — pure state machine for scroll-up older-chunk pagination.
// No DOM access: loaded by media/main.js in the webview and exercised by
// scripts/check-paging.mjs in a Node vm sandbox (fake window).
// textContent discipline applies to callers; this module only holds state.
"use strict";

(function () {
  /** Fresh state: nothing loadable (matches a non-truncated stream start). */
  function initialState() {
    return { canLoad: false, startOffset: 0, loading: false, done: true };
  }

  /**
   * State after a streamStart message.
   * canLoad only when the session was truncated AND history remains (offset > 0).
   */
  function start(state, truncated, startOffset) {
    var off = typeof startOffset === "number" && isFinite(startOffset) && startOffset > 0 ? startOffset : 0;
    var trunc = !!truncated;
    return {
      canLoad: trunc && off > 0,
      startOffset: off,
      loading: false,
      done: !trunc || off <= 0
    };
  }

  /**
   * The list scrolled to the very top. Returns [newState, shouldRequest].
   * No double-load: a request is refused while one is in flight (loading)
   * or when there is nothing left to load (done / !canLoad).
   */
  function requestOlder(state) {
    if (!state || !state.canLoad || state.loading || state.done) {
      return [state, false];
    }
    return [{ canLoad: true, startOffset: state.startOffset, loading: true, done: false }, true];
  }

  /** An olderChunk message arrived from the host. */
  function receiveOlder(state, msg) {
    var off = msg && typeof msg.newStartOffset === "number" && isFinite(msg.newStartOffset) ? msg.newStartOffset : 0;
    if (off < 0) {
      off = 0;
    }
    var done = !!(msg && msg.done) || off <= 0;
    return {
      canLoad: !done && off > 0,
      startOffset: off,
      loading: false,
      done: done
    };
  }

  window.PairletPaging = {
    initialState: initialState,
    start: start,
    requestOlder: requestOlder,
    receiveOlder: receiveOlder
  };
})();
