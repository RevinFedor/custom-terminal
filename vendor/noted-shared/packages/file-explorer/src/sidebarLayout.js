import { getSortComparator } from './treeSort.js'

export const ROOT_PARENT = '__root__'

export const emptySidebarLayout = () => ({
  orderByParent: {},
  visualParentByPath: {},
})

export function normalizeSidebarLayout(raw) {
  const layout = emptySidebarLayout()
  if (!raw || typeof raw !== 'object') return layout

  if (raw.orderByParent && typeof raw.orderByParent === 'object') {
    for (const [parent, ids] of Object.entries(raw.orderByParent)) {
      if (!Array.isArray(ids)) continue
      const seen = new Set()
      layout.orderByParent[parent] = ids.filter(id => {
        if (typeof id !== 'string' || !id || seen.has(id)) return false
        seen.add(id)
        return true
      })
    }
  }

  if (raw.visualParentByPath && typeof raw.visualParentByPath === 'object') {
    for (const [child, parent] of Object.entries(raw.visualParentByPath)) {
      if (typeof child === 'string' && child && typeof parent === 'string' && parent && child !== parent) {
        layout.visualParentByPath[child] = parent
      }
    }
  }

  return layout
}

export function sameSidebarLayout(a, b) {
  return JSON.stringify(normalizeSidebarLayout(a)) === JSON.stringify(normalizeSidebarLayout(b))
}

export function hasSidebarLayoutEntries(raw) {
  const layout = normalizeSidebarLayout(raw)
  return Object.values(layout.orderByParent).some(ids => ids.length > 0) ||
    Object.keys(layout.visualParentByPath).length > 0
}

export function pathParentKey(path, rootPath) {
  if (!path || !rootPath) return ROOT_PARENT
  if (path === rootPath) return ROOT_PARENT
  if (!path.startsWith(rootPath + '/')) return ROOT_PARENT
  const slash = path.lastIndexOf('/')
  const parent = slash > 0 ? path.slice(0, slash) : rootPath
  return parent && parent !== rootPath ? parent : ROOT_PARENT
}

export function layoutParentKeyForDirectory(dirPath, rootPath) {
  return dirPath && dirPath !== rootPath ? dirPath : ROOT_PARENT
}

export function nodeParentKey(node, rootPath) {
  return pathParentKey(node?.id, rootPath)
}

export function collectTreeIds(nodes) {
  const ids = new Set()
  const walk = (items) => {
    for (const node of items || []) {
      if (!node?.id) continue
      ids.add(node.id)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return ids
}

function collectLoadedDirectoryIds(nodes) {
  const ids = new Set([ROOT_PARENT])
  const walk = (items) => {
    for (const node of items || []) {
      if (node?.isDirectory && Array.isArray(node.children) && node.children.length > 0) {
        ids.add(node.id)
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return ids
}

function hasVisualCycle(childId, parentId, visualParentByPath) {
  let cursor = parentId
  const seen = new Set([childId])
  while (cursor) {
    if (seen.has(cursor)) return true
    seen.add(cursor)
    cursor = visualParentByPath[cursor]
  }
  return false
}

function reorderSiblings(nodes, parentKey, layout, rootPath, sortMode) {
  const comparator = getSortComparator(sortMode === 'manual' ? 'name-asc' : sortMode)
  const base = [...(nodes || [])].sort(comparator)
  const byId = new Map(base.map(node => [node.id, node]))
  const order = sortMode === 'manual' && Array.isArray(layout.orderByParent?.[parentKey])
    ? layout.orderByParent[parentKey]
    : []
  const used = new Set()
  const ordered = []

  for (const id of order) {
    const node = byId.get(id)
    if (!node || used.has(id)) continue
    ordered.push(node)
    used.add(id)
  }
  for (const node of base) {
    if (!used.has(node.id)) ordered.push(node)
  }

  const visualParentByPath = layout.visualParentByPath || {}
  const childrenByParent = new Map()
  const roots = []
  const siblingIds = new Set(ordered.map(node => node.id))

  for (const node of ordered) {
    const visualParentId = visualParentByPath[node.id]
    const parent = visualParentId ? byId.get(visualParentId) : null
    const valid =
      visualParentId &&
      siblingIds.has(visualParentId) &&
      parent &&
      !parent.isDirectory &&
      !node.isDirectory &&
      !hasVisualCycle(node.id, visualParentId, visualParentByPath)

    if (!valid) {
      roots.push(node)
      continue
    }

    const list = childrenByParent.get(visualParentId) || []
    list.push(node)
    childrenByParent.set(visualParentId, list)
  }

  const result = []
  const seen = new Set()
  const visit = (node, depth = 0, parentId = null) => {
    if (!node || seen.has(node.id)) return
    seen.add(node.id)
    const childParentKey = layoutParentKeyForDirectory(node.id, rootPath)
    const nextChildren = node.children
      ? reorderSiblings(node.children, childParentKey, layout, rootPath, sortMode)
      : node.children
    result.push({
      ...node,
      children: nextChildren,
      visualParentId: parentId || undefined,
      visualDepth: depth,
    })
    for (const child of childrenByParent.get(node.id) || []) {
      visit(child, Math.min(depth + 1, 4), node.id)
    }
  }

  for (const node of roots) visit(node, 0, null)
  for (const node of ordered) visit(node, 0, null)
  return result
}

export function applySidebarLayout(nodes, rawLayout, rootPath, sortMode = 'name-asc') {
  const layout = normalizeSidebarLayout(rawLayout)
  return reorderSiblings(nodes || [], ROOT_PARENT, layout, rootPath, sortMode)
}

export function pruneSidebarLayout(rawLayout, rootPath, nodes) {
  const layout = normalizeSidebarLayout(rawLayout)
  const ids = collectTreeIds(nodes)
  const loadedParents = collectLoadedDirectoryIds(nodes)
  const next = emptySidebarLayout()

  for (const [parent, order] of Object.entries(layout.orderByParent)) {
    if (!loadedParents.has(parent)) {
      next.orderByParent[parent] = order
      continue
    }
    const filtered = order.filter(id => ids.has(id) && parent === nodeParentKey({ id }, rootPath))
    if (filtered.length > 0) next.orderByParent[parent] = filtered
  }

  for (const [child, parent] of Object.entries(layout.visualParentByPath)) {
    const childLoaded = ids.has(child)
    const parentLoaded = ids.has(parent)
    if (!childLoaded && !parentLoaded) {
      next.visualParentByPath[child] = parent
      continue
    }
    if (!childLoaded || !parentLoaded) continue
    if (pathParentKey(child, rootPath) !== pathParentKey(parent, rootPath)) continue
    if (hasVisualCycle(child, parent, layout.visualParentByPath)) continue
    next.visualParentByPath[child] = parent
  }

  return next
}

export function rewriteSidebarLayoutPath(rawLayout, oldPath, newPath) {
  const layout = normalizeSidebarLayout(rawLayout)
  if (!oldPath) return layout
  const isUnder = (p) => p === oldPath || p.startsWith(oldPath + '/')
  const rewrite = (p) => (newPath ? newPath + p.slice(oldPath.length) : null)
  const next = emptySidebarLayout()

  for (const [parent, order] of Object.entries(layout.orderByParent)) {
    const nextParent = isUnder(parent) ? rewrite(parent) : parent
    if (!nextParent) continue
    const mapped = []
    const seen = new Set()
    for (const id of order) {
      const nextId = isUnder(id) ? rewrite(id) : id
      if (!nextId || seen.has(nextId)) continue
      mapped.push(nextId)
      seen.add(nextId)
    }
    if (mapped.length > 0) next.orderByParent[nextParent] = mapped
  }

  for (const [child, parent] of Object.entries(layout.visualParentByPath)) {
    const nextChild = isUnder(child) ? rewrite(child) : child
    const nextParent = isUnder(parent) ? rewrite(parent) : parent
    if (!nextChild || !nextParent || nextChild === nextParent) continue
    next.visualParentByPath[nextChild] = nextParent
  }

  return next
}

export function removePathFromSidebarLayout(rawLayout, path) {
  return rewriteSidebarLayoutPath(rawLayout, path, null)
}
