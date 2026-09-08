// Shared wording for the operation-based external-editor capture protocol.
export const AGENT_DRAFT_CAPTURE_ERRORS: Record<string, string> = {
  codex_input_not_ready: 'Codex input is still starting — draft preserved',
  external_editor_timeout: 'Input transfer timed out and was cancelled — draft preserved',
  external_editor_pending_drain: 'The previous input transfer is still returning — no new transfer was started',
  capture_generation_changed: 'The terminal restarted during input transfer — draft preserved',
  capture_pty_write_failed: 'Could not request input transfer — draft preserved',
};
