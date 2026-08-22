/**
 * Serialize the durable commit of newly created tabs per project.
 * The candidate Map is built only after earlier creations have published, and
 * it is never exposed when persistence rejects it.
 */
export function commitCreatedTabSnapshot({
  queue,
  projectId,
  isWorkspaceCurrent,
  getCurrentTabs,
  getPersistenceRevision,
  buildCandidateTabs,
  persist,
  publish,
}) {
  return queue.enqueue(projectId, async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (!isWorkspaceCurrent()) {
        return { success: false, error: 'project_closed_during_tab_creation' };
      }
      const baseEntries = [...getCurrentTabs().entries()];
      const candidateTabs = buildCandidateTabs(new Map(baseEntries));
      const snapshot = await persist(candidateTabs);
      if (snapshot?.success === false) return snapshot;

      const currentEntries = [...getCurrentTabs().entries()];
      const mapUnchanged = currentEntries.length === baseEntries.length
        && currentEntries.every(([id, tab], index) => (
          baseEntries[index]?.[0] === id && baseEntries[index]?.[1] === tab
        ));
      const persistenceUnchanged = typeof getPersistenceRevision !== 'function'
        || snapshot?.persistenceRevision == null
        || Number(snapshot.persistenceRevision) === Number(getPersistenceRevision());
      if (!mapUnchanged || !persistenceUnchanged) {
        if (attempt === 4) {
          return { success: false, error: 'tab_creation_concurrent_mutation' };
        }
        continue;
      }

      publish(candidateTabs);
      return snapshot;
    }
    return { success: false, error: 'tab_creation_concurrent_mutation' };
  });
}
