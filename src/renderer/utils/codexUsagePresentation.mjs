function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

export function buildCodexMainUsageView(usage) {
  const weeklyUsed = finitePercent(usage?.seven_day?.utilization);
  const fiveHourUsed = finitePercent(usage?.five_hour?.utilization);
  return {
    weeklyUsed,
    fiveHourUsed,
    hasWeekly: weeklyUsed != null,
    hasFiveHour: fiveHourUsed != null,
    showDivider: weeklyUsed != null && fiveHourUsed != null,
    metricKeys: [weeklyUsed != null ? 'weekly' : null, fiveHourUsed != null ? 'five-hour' : null]
      .filter(Boolean),
  };
}

export function buildCodexAdditionalLimitRows(limits) {
  const rows = [];
  for (const limit of Array.isArray(limits) ? limits : []) {
    if (!limit || typeof limit !== 'object' || typeof limit.key !== 'string') continue;
    const weeklyUsed = finitePercent(limit.seven_day?.utilization);
    const fiveHourUsed = finitePercent(limit.five_hour?.utilization);
    if (weeklyUsed != null) {
      rows.push({
        key: `${limit.key}:weekly`,
        limitKey: limit.key,
        label: limit.label,
        kind: 'weekly',
        usedPercent: weeklyUsed,
        resetsAt: limit.seven_day?.resets_at ?? null,
      });
    }
    if (fiveHourUsed != null) {
      rows.push({
        key: `${limit.key}:five-hour`,
        limitKey: limit.key,
        label: limit.label,
        kind: 'five-hour',
        usedPercent: fiveHourUsed,
        resetsAt: limit.five_hour?.resets_at ?? null,
      });
    }
  }
  return rows;
}

export function visibleCodexResetCredits(snapshot, nowMs = Date.now()) {
  return (Array.isArray(snapshot?.credits) ? snapshot.credits : [])
    .filter((credit) => credit && typeof credit === 'object')
    .filter((credit) => Number.isFinite(Date.parse(credit.expires_at)))
    .filter((credit) => Date.parse(credit.expires_at) > nowMs)
    .map((credit) => ({
      title: typeof credit.title === 'string' && credit.title.trim() ? credit.title.trim() : 'Full reset',
      expires_at: new Date(credit.expires_at).toISOString(),
    }))
    .sort((left, right) => Date.parse(left.expires_at) - Date.parse(right.expires_at));
}
