export interface CodexRewindCommitResolution {
  sourceSessionId: string;
  activeSessionId: string;
  writerChanged: boolean;
}

const cleanSessionId = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

/**
 * Main owns the proof taxonomy for a native Codex Rewind. Renderer only
 * verifies the durable commit boundary and that the reply still belongs to
 * the session currently shown by this tab.
 *
 * In particular, do not branch on `handoffStatus` here. Main can legitimately
 * commit either a newly adopted child writer or the proven-stable source
 * writer, and may add more proof modes without changing this UI contract.
 */
export function requireCommittedCodexRewind(
  result: unknown,
  currentSessionId: unknown,
): CodexRewindCommitResolution {
  const reply = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : {};
  const sourceSessionId = cleanSessionId(reply.sourceSessionId);
  const activeSessionId = cleanSessionId(reply.activeSessionId);
  const current = cleanSessionId(currentSessionId);

  if (reply.success !== true
    || reply.bindingCommitted !== true
    || !sourceSessionId
    || !activeSessionId) {
    throw new Error('Codex Rewind применился, но сохранённый результат сессии не подтверждён');
  }
  if (!current || (current !== sourceSessionId && current !== activeSessionId)) {
    throw new Error('Результат Codex Rewind устарел: вкладка уже перешла на другую ветку');
  }

  return {
    sourceSessionId,
    activeSessionId,
    writerChanged: sourceSessionId !== activeSessionId,
  };
}
