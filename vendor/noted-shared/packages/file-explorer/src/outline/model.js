export const ROOT_LAYOUT_PARENT = '__root__'

const childrenOf = node => Array.isArray(node?.children) ? node.children : []

const cloneLayout = raw => {
  const orderByParent = {}
  const visualParentByPath = {}
  for (const [parentId, ids] of Object.entries(raw?.orderByParent || {})) {
    if (Array.isArray(ids)) orderByParent[parentId] = [...ids]
  }
  for (const [childId, parentId] of Object.entries(raw?.visualParentByPath || {})) {
    if (childId && parentId && childId !== parentId) visualParentByPath[childId] = parentId
  }
  return { orderByParent, visualParentByPath }
}

function physicalGroupKey(parentId, rootPath) {
  return !parentId || parentId === rootPath ? ROOT_LAYOUT_PARENT : parentId
}

function orderPhysicalSiblings(nodes, layout, physicalParentId, rootPath, sortMode) {
  const base = [...(nodes || [])]
  // Sidebar has already sorted `nodes` with the selected name/date comparator.
  // Persisted sibling order owns the result only in explicit manual mode;
  // applying it for every mode makes a freshly discovered file look missing by
  // appending it after every path saved in an older manual layout.
  if (sortMode !== 'manual') return base
  const groupKey = physicalGroupKey(physicalParentId, rootPath)
  const requested = layout?.orderByParent?.[groupKey]
  if (!Array.isArray(requested) || requested.length === 0) return base
  const byId = new Map(base.map(node => [node.id, node]))
  const ordered = []
  const used = new Set()
  for (const id of requested) {
    const node = byId.get(id)
    if (!node || used.has(id)) continue
    ordered.push(node)
    used.add(id)
  }
  for (const node of base) {
    if (!used.has(node.id)) ordered.push(node)
  }
  return ordered
}

function buildSiblingOutline(nodes, expandedState, physicalParentId, rootPath, layout, sortMode) {
  const orderedNodes = orderPhysicalSiblings(nodes, layout, physicalParentId, rootPath, sortMode)
  const entries = orderedNodes.map(rawNode => {
    const isFolder = !!rawNode.isDirectory
    const expanded = isFolder ? !!expandedState?.[rawNode.id] : true
    const physicalChildren = isFolder
      ? buildSiblingOutline(childrenOf(rawNode), expandedState, rawNode.id, rootPath, layout, sortMode)
      : []
    return {
      id: rawNode.id,
      kind: isFolder ? 'folder' : 'file',
      collapsible: isFolder,
      expanded,
      hasChildren: isFolder
        ? rawNode.hasChildren !== false || physicalChildren.length > 0
        : false,
      children: physicalChildren,
      data: {
        rawNode,
        physicalParentId,
        originalVisualParentId: layout?.visualParentByPath?.[rawNode.id] || rawNode.visualParentId || null,
        childrenLoaded: !isFolder || rawNode.hasChildren === false || physicalChildren.length > 0,
      },
    }
  })

  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const roots = []
  for (const entry of entries) {
    const visualParentId = entry.data.originalVisualParentId
    const visualParent = visualParentId ? byId.get(visualParentId) : null
    if (!visualParent || visualParent === entry) {
      roots.push(entry)
      continue
    }
    visualParent.children.push(entry)
    visualParent.hasChildren = true
  }
  return roots
}

export function buildFileOutline(nodes, {
  expandedState = {},
  rootPath,
  layout = {},
  sortMode = 'manual',
} = {}) {
  if (!rootPath) throw new Error('buildFileOutline requires rootPath')
  return buildSiblingOutline(nodes, expandedState, rootPath, rootPath, layout, sortMode)
}

export function findOutlineLocation(nodes, targetId) {
  let found = null
  const visit = (siblings, parent = null, ancestors = []) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index]
      if (node.id === targetId) {
        found = { node, parent, parentId: parent?.id || null, index, ancestors }
        return true
      }
      if (visit(childrenOf(node), node, [...ancestors, node])) return true
    }
    return false
  }
  visit(nodes || [], null, [])
  return found
}

function collectSubtreeNodes(node) {
  const result = []
  const visit = current => {
    if (!current) return
    result.push(current)
    for (const child of childrenOf(current)) visit(child)
  }
  visit(node)
  return result
}

function physicalMoveRoots(sourceNode) {
  const movableNodes = collectSubtreeNodes(sourceNode)
    .filter(node => !node.data?.rawNode?.isLink)
  const movableIds = new Set(movableNodes.map(node => node.id))

  return movableNodes
    .map(node => node.id)
    .filter(nodeId => {
      let slash = nodeId.lastIndexOf('/')
      while (slash > 0) {
        const ancestorPath = nodeId.slice(0, slash)
        if (movableIds.has(ancestorPath)) return false
        slash = ancestorPath.lastIndexOf('/')
      }
      return true
    })
}

function desiredPhysicalParent(location, rootPath) {
  if (!location) return rootPath
  for (let index = location.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = location.ancestors[index]
    if (ancestor.kind === 'folder') return ancestor.id
  }
  return rootPath
}

export function outlineToSidebarLayout(outline, {
  rootPath,
  previousLayout,
} = {}) {
  if (!rootPath) throw new Error('outlineToSidebarLayout requires rootPath')
  const next = cloneLayout(previousLayout)
  const representedGroups = new Set([ROOT_LAYOUT_PARENT])
  const idsByGroup = new Map()
  const visualParents = new Map()
  const representedNodeIds = new Set()

  const append = (groupKey, nodeId) => {
    const ids = idsByGroup.get(groupKey) || []
    if (!ids.includes(nodeId)) ids.push(nodeId)
    idsByGroup.set(groupKey, ids)
  }

  const visit = (nodes, nearestFolderId, directParent = null) => {
    for (const node of nodes || []) {
      const physicalParentId = directParent?.kind === 'folder'
        ? directParent.id
        : nearestFolderId
      const groupKey = physicalGroupKey(physicalParentId, rootPath)
      representedNodeIds.add(node.id)
      append(groupKey, node.id)

      if (directParent?.kind === 'file') visualParents.set(node.id, directParent.id)

      if (node.kind === 'folder' && node.data?.childrenLoaded) {
        representedGroups.add(physicalGroupKey(node.id, rootPath))
      }
      visit(
        childrenOf(node),
        node.kind === 'folder' ? node.id : physicalParentId,
        node,
      )
    }
  }
  visit(outline || [], rootPath)

  for (const groupKey of representedGroups) {
    next.orderByParent[groupKey] = idsByGroup.get(groupKey) || []
  }

  for (const childId of representedNodeIds) delete next.visualParentByPath[childId]
  for (const [childId, parentId] of visualParents) {
    next.visualParentByPath[childId] = parentId
  }
  return next
}

export function planFileOutlineCommit({
  originalOutline,
  previewOutline,
  sourceId,
  rootPath,
  previousLayout,
} = {}) {
  const original = findOutlineLocation(originalOutline, sourceId)
  const preview = findOutlineLocation(previewOutline, sourceId)
  if (!original || !preview) throw new Error(`Unknown outline source: ${sourceId}`)

  const originalPhysicalParent = original.node.data?.physicalParentId || rootPath
  const destinationFolder = desiredPhysicalParent(preview, rootPath)
  const destinationLocation = findOutlineLocation(previewOutline, destinationFolder)
  const layout = outlineToSidebarLayout(previewOutline, { rootPath, previousLayout })
  const isLink = !!original.node.data?.rawNode?.isLink
  const sourceIds = collectSubtreeNodes(original.node).map(node => node.id)
  const physicalSourceIds = isLink ? [] : physicalMoveRoots(original.node)

  return {
    sourceId,
    sourceNode: original.node,
    destinationFolder,
    expandDestination: destinationFolder !== rootPath
      && destinationLocation?.node?.kind === 'folder'
      && destinationLocation.node.expanded === true,
    originalPhysicalParent,
    requiresPhysicalMove: !isLink && originalPhysicalParent !== destinationFolder,
    sourceIds,
    physicalSourceIds,
    layout,
    action: {
      kind: !isLink && originalPhysicalParent !== destinationFolder ? 'move' : 'layout',
      mode: 'outline-v2',
      sourceIds,
      physicalSourceIds,
      destinationFolder,
      layout,
    },
  }
}
