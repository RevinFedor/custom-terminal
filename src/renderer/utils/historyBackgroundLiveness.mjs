/**
 * Is this subagent card still LIVE work, i.e. should it own a background chip?
 *
 * Three shapes of card reach this, and conflating any two of them breaks a real
 * scenario:
 *
 *  1. Codex in-process subagent — explicit rollout status AND the process
 *     generation it belongs to. Process-scoped: a durable `running` record is
 *     not a lease on every future Codex process that reuses the tab, so the
 *     generation must be present and match. A historical Codex card with no
 *     generation is unproven and stays visible-but-dead.
 *
 *  2. Claude async (backgrounded) agent — explicit status derived from its
 *     acceptance receipt and task-notifications, but NEVER a generation:
 *     nothing on the Claude side writes one. Also process-scoped (it outlives
 *     its spawn turn by design), gated by process liveness alone.
 *
 *  3. Claude live spawn card — no status yet. Without an exact main-owned
 *     async acceptance it is turn-scoped (the synchronous case); with that
 *     exact lease it is the live face of case 2 while durable History catches
 *     up after the parent turn.
 *
 * Scar 2026-07-29 (production tab-2598): the generation requirement was added
 * for case 1 and silently swallowed case 2 — a Claude background agent can
 * never satisfy "generation is set and matches", so its chip was impossible and
 * the steps pane had nothing to open. Both changes were individually correct
 * and individually tested; only their intersection was broken. Hence `toolType`
 * is passed explicitly instead of guessing the provider from which fields
 * happen to be populated.
 */
export function isHistoryTaskBackgroundLive({
  toolType,
  subagentStatus,
  actionProcessGeneration,
  currentProcessGeneration,
  agentProcessAlive,
  inLastTurn,
  isTurnBusy,
  hasResult,
}) {
  if (subagentStatus) {
    if (subagentStatus !== 'running') return false;
    if (agentProcessAlive !== true) return false;
    // Claude never emits a generation — requiring one here is what killed
    // every background Claude agent. Its liveness is the process itself.
    if (toolType === 'claude') return true;
    // Codex: the generation is the proof that this record belongs to the
    // process running right now, not to a previous one on the same tab.
    return !!actionProcessGeneration
      && actionProcessGeneration === currentProcessGeneration;
  }

  return inLastTurn === true && isTurnBusy === true && hasResult !== true;
}

/**
 * Final chip decision after joining a transcript card with main-owned exact
 * activity. A live Claude Agent card initially has no subagentStatus even
 * after its async acceptance (the live projector only saw the spawn), so the
 * exact main lease must be able to carry it across parent busy → idle before
 * the durable History refresh arrives.
 *
 * Conversely an explicit durable `running` status without the exact lease is
 * historical evidence only and must not resurrect a finished child.
 */
export function isHistoryTaskChipLive({
  exactActive,
  ...card
}) {
  if (exactActive === true) return card.agentProcessAlive === true;
  if (card.subagentStatus) return false;
  return isHistoryTaskBackgroundLive(card);
}
