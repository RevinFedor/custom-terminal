// Pure historical slash observation, shared by the renderer and packaged reader.
// Selection order and proof timestamps deliberately retain the legacy reducer.
export function deriveCodexEffectiveSettingsFromHistory(entries) {
  let model = '';
  let effort = '';
  let proofAt = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.role !== 'slash') continue;
    const content = String(entry.content || '').trim();
    const modelMatch = content.match(/^\/model\s+([a-z0-9][a-z0-9_.-]*)$/i);
    if (modelMatch) {
      model = modelMatch[1];
      const timestamp = Date.parse(String(entry.timestamp || ''));
      if (Number.isFinite(timestamp)) proofAt = Math.max(proofAt, timestamp);
      continue;
    }
    const effortMatch = content.match(/^\/effort\s+(none|minimal|low|medium|high|xhigh|max|ultra)$/i);
    if (effortMatch) {
      effort = effortMatch[1].toLowerCase();
      const timestamp = Date.parse(String(entry.timestamp || ''));
      if (Number.isFinite(timestamp)) proofAt = Math.max(proofAt, timestamp);
    }
  }
  if (!model && !effort) return null;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    proofAt,
    proof: 'rollout-turn-context',
  };
}
