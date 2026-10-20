'use strict';
// Frozen pre-observability readCapture declaration from f1d01fbb…342e8.
// Only this declaration executes in the controlled SQL/projection harness.
function frozenCapture({ service, read, database, legacyNamespaceIds, namespaceIds, db, projectWorkflowCatalog, fingerprint }) {
  let catalogFlight = null;
  const readCapture = () => {
    if (catalogFlight) return catalogFlight;
    // Join only before capture. No settled cache, timer or publication-only key:
    // legacy metadata can change without advancing the organization revision.
    const flight = new Promise((resolve,reject) => setImmediate(() => {
      try {
        const captured = service.read(() => {
          const snapshot = read();
          const saved = database.getAppState('workspace-session');
          const legacyNamespaces = legacyNamespaceIds();
          const namespaceOrder = [...(Array.isArray(saved?.openProjects) ? saved.openProjects : []).map(project=>project.projectId),
            ...namespaceIds(snapshot.tabs,legacyNamespaces)];
          const aliases = db.prepare('SELECT namespace,tab_id AS tabId,global_tab_id AS globalTabId FROM workflow_org_aliases ORDER BY rowid').all();
          const dto = projectWorkflowCatalog({snapshot,namespaceOrder,legacyNamespaces,aliases});
          dto.clocks.descriptors = {kind:'content-hash',value:fingerprint({rows:dto.rows,executionRefs:dto.executionRefs,provenance:dto.provenance})};
          dto.clocks.tree = {kind:'content-hash',value:fingerprint(dto.workflows.map(({id,memberTabIds,rootIds,nodes})=>({id,memberTabIds,rootIds,nodes})))};
          const freeze = value => {if(value && typeof value==='object' && !Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
          return freeze({snapshot,dto,namespaceOrder,legacyNamespaces,aliases});
        });
        resolve(captured);
      } catch (error) {reject(error);
      } finally {if (catalogFlight===flight) catalogFlight=null;}
    }));
    catalogFlight=flight;
    return flight;
  };
  return readCapture;
}
module.exports = { frozenCapture };
