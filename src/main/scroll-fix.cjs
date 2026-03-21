/**
 * scroll-fix.cjs — Fixes terminal scroll-to-top regression in Claude Code
 *
 * Source: anthropics/claude-code#35683
 *
 * ROOT CAUSE:
 *   Ink renderer's eraseLines() and readline/prompt system emit cursor-up
 *   sequences exceeding viewport height, causing ALL terminals to snap
 *   the viewport to the top of scrollback.
 *
 * FIX:
 *   Intercepts ALL process.stdout.write calls. Every cursor-up sequence
 *   (\x1b[{n}A) is clamped so the TOTAL cursor-up per write call never
 *   exceeds process.stdout.rows. No sync-block tracking needed.
 *
 * Upstream: microsoft/terminal#14774, anthropics/claude-code#33814
 */

"use strict";

process.stderr.write("[scroll-fix] loaded\n");

(function () {
  var _ow = process.stdout.write.bind(process.stdout);

  /* ── stdout.write interceptor ─────────────────────────────────────── */
  process.stdout.write = function (d, e, c) {
    if (typeof e === "function") {
      c = e;
      e = void 0;
    }
    var s =
      typeof d === "string"
        ? d
        : Buffer.isBuffer(d)
          ? d.toString("utf-8")
          : String(d);
    var maxUp = process.stdout.rows || 24;

    /* Clamp cursor-up per write call.
     * Never let total upward movement in a single write exceed viewport. */
    var upBudget = maxUp;

    s = s.replace(/\x1b\[(\d*)A/g, function (m, p) {
      var n = parseInt(p) || 1;
      if (upBudget <= 0) return "";
      var allowed = n > upBudget ? upBudget : n;
      upBudget -= allowed;
      return "\x1b[" + allowed + "A";
    });

    if (typeof d === "string") return _ow(s, e, c);
    return _ow(Buffer.from(s, "utf-8"), e, c);
  };
})();
