export function resolveDockBusyBadgeState(normalBusyTabIds, inheritedBusyTabIds) {
  const normal = new Set(normalBusyTabIds || []);
  const all = new Set(normal);
  for (const tabId of inheritedBusyTabIds || []) all.add(tabId);

  return {
    count: all.size,
    kind: all.size > 0 && normal.size === 0 ? 'inherited' : 'active',
  };
}
