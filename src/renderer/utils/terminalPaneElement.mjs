// TerminalArea publishes one stable DOM id per retained tab. Re-read that
// index on every call, including after replacement; no node identity is cached.
// Legacy/empty surfaces without that id retain the exact attribute lookup.
export function findTerminalPaneElement(tabId, ownerDocument = document) {
  // Vacant pane chrome has no tab surface; its pane-scoped height stays on the host.
  if (tabId === '') return null;
  const indexed = ownerDocument.getElementById(`terminal-pane-wrapper:${tabId}`);
  if (indexed?.isConnected
      && indexed.getAttribute('data-terminal-pane-wrapper') === tabId) return indexed;
  const escape = ownerDocument.defaultView?.CSS?.escape || globalThis.CSS.escape;
  return ownerDocument.querySelector(`[data-terminal-pane-wrapper="${escape(tabId)}"]`);
}
