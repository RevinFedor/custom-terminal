/** Navigation and transcript IO have separate owners. A late locator must not
 * scroll a tab the user has already left, or supersede a newer click. */
export function createTabMessageSourceNavigation(deps) {
  let pending = null;
  const cancel = () => {
    if (!pending) return;
    const previous = pending;
    pending = null;
    previous.cancel();
  };
  return {
    cancel,
    async jump(source) {
      cancel();
      if (!source.messageId || !source.sourceTabId) throw new Error('tab_message_source_identity_unavailable');
      const operation = { cancel: () => {} };
      pending = operation;
      let unsubscribe = () => {}, unsubscribeIntent = () => {}, cancelWait = () => {};
      let generation = null;
      let completed = false;
      operation.cancel = () => {
        unsubscribe(); unsubscribeIntent(); cancelWait();
        if (generation !== null) deps.cancelScroll(generation);
      };
      try {
        if (!await deps.open(source)) throw new Error('tab_message_source_tab_unavailable');
        if (pending !== operation) return false;
        const placement = deps.placement();
        unsubscribe = deps.subscribePlacement(() => {
          if (pending === operation && deps.placement() !== placement) cancel();
        });
        unsubscribeIntent = deps.subscribeIntent?.(() => { if (pending === operation) cancel(); }) || (() => {});
        const result = await deps.locate(source.messageId, source);
        if (pending !== operation) return false;
        const location = result?.location;
        if (!result?.success) throw new Error(result?.error || 'tab_message_source_call_not_found');
        if (location?.messageId !== source.messageId || location?.tabId !== source.sourceTabId
          || !location.entryUuid || (!location.toolUseId && !location.messageReference) || !location.readSessionId) {
          throw new Error('tab_message_source_identity_changed');
        }
        const requestId = deps.requestId(source);
        const wait = deps.waitForScroll(requestId);
        cancelWait = wait.cancel;
        deps.reveal(location.tabId);
        generation = deps.scroll(location, requestId);
        const settled = await wait.promise;
        if (pending !== operation) return false;
        if (!settled?.found) throw new Error(settled?.reason || 'tab_message_source_scroll_failed');
        completed = true;
        return true;
      } catch (error) {
        if (pending !== operation) return false;
        throw error;
      } finally {
        unsubscribe(); unsubscribeIntent(); cancelWait();
        if (pending === operation) {
          pending = null;
          if (!completed && generation !== null) deps.cancelScroll(generation);
        }
      }
    },
  };
}
