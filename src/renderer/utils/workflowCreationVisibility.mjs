// Bounded observation of newly allocated tabs only. No subscriptions, timers,
// layout reads, store writes, names or provider content. A DOM row confirms
// publication, not that the row was inside the user's scrolled viewport.
export function createWorkflowCreationVisibility({log = text => console.log(text), limit = 32, now = Date.now} = {}) {
  const pending = new Map();
  const emit = data => { try { log('[WorkflowCreation:visibility] ' + JSON.stringify(data)); } catch {} };
  return {
    hasPending: () => pending.size > 0,
    allocated({tabId,workflowId,namespace,sourceTabId,background,revision}) {
      if (pending.has(tabId)) return;
      if (pending.size >= limit) {
        const oldest = pending.keys().next().value;
        pending.delete(oldest); emit({tabId:oldest,stage:'evicted',reason:'trace-capacity'});
      }
      const startedAt = now();
      pending.set(tabId,{workflowId,startedAt,last:null});
      emit({tabId,workflowId,namespace,sourceTabId:sourceTabId || null,background:!!background,revision,stage:'allocated',at:startedAt});
    },
    observe({state,model,outlineIds,rowIds,element,dragPhase}) {
      if (!pending.size) return;
      const reserve = new Set(model.reserve.map(owner => owner.tabId));
      for (const [tabId,trace] of pending) {
        const member = state.tabWorkflowMembership?.[tabId], owner = model.catalog.get(tabId);
        const workflowId = member?.workflowId || trace.workflowId;
        const stage = !member ? 'membership-missing'
          : !owner ? 'renderer-tab-missing'
            : owner.active === false ? 'presentation-inactive'
              : model.placed.has(tabId) ? 'placed'
                : workflowId !== state.activeSpaceId ? 'other-workflow'
                  : !reserve.has(tabId) ? 'reserve-filtered'
                    : !outlineIds.has(tabId) ? 'outline-missing'
                      : !rowIds.has(tabId) ? 'row-hidden-or-pending' : 'row-ready';
        const dom = stage === 'row-ready' && !!element && Array.from(element.querySelectorAll('[data-workflow-reserve-tab]'))
          .some(row => row.getAttribute('data-workflow-reserve-tab') === tabId);
        const signature = JSON.stringify([state.activeSpaceId,workflowId,stage,dom,dragPhase || null]);
        if (signature === trace.last) continue;
        trace.last = signature;
        emit({tabId,workflowId,activeWorkflowId:state.activeSpaceId,stage:dom?'dom-mounted':stage,
          dragPhase:dragPhase || null,ageMs:now()-trace.startedAt,at:now()});
        if (dom || stage === 'placed') pending.delete(tabId);
      }
    },
  };
}

export const workflowCreationVisibility = createWorkflowCreationVisibility();
