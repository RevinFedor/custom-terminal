/**
 * Does the process occupying an AI tab's shell belong to the agent itself?
 *
 * Closing a tab treats these two cases differently: an agent that merely holds
 * a live session is safe to close (its history stays on disk, Continue works),
 * while an unrelated process — a build, a dev server, a script — must be
 * confirmed because closing kills work the user started by hand.
 *
 * The check only ever sees the shell's FIRST direct child. Agents differ in
 * what that child looks like:
 *   claude  → the binary itself
 *   codex   → `node /opt/homebrew/bin/codex …`, a launcher that spawns the real
 *             vendor binary one level deeper
 * so both the short name and the full command line are inspected.
 */

const AGENT_NAMES = ['claude', 'gemini', 'codex'];

/**
 * Matching on a word boundary alone is wrong: in `/opt/homebrew/bin/codex` the
 * agent name is preceded by a slash, and `\b` does not treat `/` as the kind of
 * boundary that makes `\bcodex\b` fire at that position reliably. A path
 * separator, a start of string, or whitespace all count as "this token is the
 * executable", while `mycodex` or `codex-helper.log` must not.
 */
const AGENT_PATTERN = new RegExp(
  `(?:^|[\\s/\\\\])(?:${AGENT_NAMES.join('|')})(?=$|[\\s/\\\\.-])`,
  'i',
);

export function isAiForegroundProcess(info) {
  if (!info?.hasProcess) return false;
  const text = `${info.processName || ''} ${info.command || ''}`.toLowerCase();
  if (!text.trim()) return false;
  // Package-qualified form appears when the vendor binary is reached through
  // node_modules rather than a bin shim.
  if (text.includes('@openai/codex')) return true;
  return AGENT_PATTERN.test(text);
}
