/**
 * Replace the editable shell line before a UI-owned command is submitted.
 *
 * A tab can look idle while zsh still contains an unsubmitted draft. Writing a
 * script name directly would append it to that draft. Ctrl+U is the same
 * kill-line control already understood by the terminal input tracker, so the
 * visible shell line and remembered last-command state are cleared together.
 */
export function replaceShellInputLine(command) {
  const text = String(command || '').replace(/^\x15+/, '');
  return `\x15${text}`;
}
