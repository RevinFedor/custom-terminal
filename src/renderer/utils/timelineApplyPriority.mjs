/** First shown rail is navigation; refreshing a populated rail is background. */
export function shouldBypassTimelineApplyPriority({
  ownerCurrent,
  presented,
  hasDurableEntries,
  phase,
  hasCachedSnapshot = false,
}) {
  // Without a cached snapshot, hydration publishes only a readiness flag.
  // Waiting for idle here delayed even starting the real read by 11 seconds.
  return !ownerCurrent
    || (phase === 'cache-hydrate' && !hasCachedSnapshot)
    || (presented === true && !hasDurableEntries);
}
