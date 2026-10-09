'use strict';

// The publication is the user's order. Metadata is a compatibility fallback
// only for IDs absent from it; an absent order is not position zero.
function orderedWorkflows(workflows, publication) {
  const rank = new Map();
  const order = publication?.metadata?.workflowOrder;
  for (const id of Array.isArray(order) ? order : []) if (!rank.has(id)) rank.set(id, rank.size);
  const fallback = workflow => {
    const value = workflow.metadata?.order;
    return typeof value === 'number' && Number.isFinite(value) ? value : Infinity;
  };
  return [...(workflows || [])].sort((a, b) => {
    const inbox = Number(a.kind === 'inbox') - Number(b.kind === 'inbox');
    if (inbox) return inbox;
    const left = rank.get(a.id), right = rank.get(b.id);
    if (left !== undefined || right !== undefined) return (left ?? Infinity) - (right ?? Infinity);
    // Stable sort retains source order for equal/unranked entries.
    return fallback(a) - fallback(b);
  });
}

module.exports = { orderedWorkflows };
