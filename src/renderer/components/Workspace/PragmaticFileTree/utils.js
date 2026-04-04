
// Helper to flatten the recursive tree into a linear list of visible items
export const flattenTree = (nodes, expandedIds, level = 0, parentId = null) => {
  let result = [];
  
  // Order is already set by loadTreeRecursive (respects user sort mode)
  for (const node of nodes) {
    // Add current node
    result.push({
      ...node,
      level,
      parentId
    });

    // If it's a directory and is expanded, add children recursively
    if (node.isDirectory && expandedIds[node.id] && node.children) {
      result = result.concat(flattenTree(node.children, expandedIds, level + 1, node.id));
    }
  }

  return result;
};
