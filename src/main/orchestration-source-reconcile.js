'use strict';

function sessionCandidateFromTab(tab) {
  const toolType = tab?.commandType === 'codex' ? 'codex' : tab?.commandType === 'claude' ? 'claude' : null;
  const sessionId = toolType === 'codex' ? tab?.codexSessionId : tab?.claudeSessionId;
  if (!toolType || typeof sessionId !== 'string' || !sessionId.trim()) return null;
  return {
    tabId: tab.tabId || null,
    tabName: tab.name || null,
    toolType,
    sessionId: sessionId.trim(),
    cwd: tab.cwd || null,
  };
}

function collectLegacySourceSessionCandidates(run, projects) {
  if (!run?.sourceProjectId || !run?.sourceTabName) return [];
  const project = (Array.isArray(projects) ? projects : [])
    .find((item) => item?.id === run.sourceProjectId || item?.projectId === run.sourceProjectId);
  if (!project) return [];
  const tabs = Array.isArray(project.tabs) ? project.tabs : [];
  const exact = tabs.filter((tab) => tab?.tabId === run.sourceTabId);
  const pool = exact.length > 0
    ? exact
    : tabs.filter((tab) => tab?.name === run.sourceTabName);
  const unique = new Map();
  for (const tab of pool) {
    const candidate = sessionCandidateFromTab(tab);
    if (!candidate) continue;
    unique.set(candidate.toolType + ':' + candidate.sessionId, candidate);
  }
  return Array.from(unique.values());
}

async function findUniqueLegacySourceFollowupProof({ run, projects, probe }) {
  if (typeof probe !== 'function') return { found: false, reason: 'legacy-probe-unavailable' };
  const candidates = collectLegacySourceSessionCandidates(run, projects);
  if (candidates.length === 0) return { found: false, reason: 'legacy-source-candidates-empty' };
  const matches = [];
  for (const candidate of candidates) {
    let proof;
    try {
      proof = await probe(candidate);
    } catch (error) {
      proof = { found: false, error: String(error?.message || error) };
    }
    if (proof?.found === true) matches.push({ candidate, proof });
  }
  if (matches.length !== 1) {
    return {
      found: false,
      reason: matches.length > 1 ? 'legacy-source-proof-ambiguous' : 'legacy-source-proof-not-found',
      candidateCount: candidates.length,
      matchCount: matches.length,
    };
  }
  return {
    found: true,
    candidate: matches[0].candidate,
    proof: matches[0].proof,
    candidateCount: candidates.length,
    matchCount: 1,
  };
}

module.exports = {
  collectLegacySourceSessionCandidates,
  findUniqueLegacySourceFollowupProof,
};
