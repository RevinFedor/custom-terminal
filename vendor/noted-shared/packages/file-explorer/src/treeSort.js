// Single source of truth for file-tree ordering. Used by the sidebar
// (loadTreeRecursive / insert / move) AND the index panel's own recursive
// load — so the two views of the same folder never disagree on order.
// See methodology/переносимый-дизайн.md (index sort parity).
//
// Works on both node shapes in the codebase: sidebar nodes ({isDirectory, name,
// mtime, birthtime, headerDate}) and raw IPC entries (same fields) — folder-first
// then the chosen mode.
//
// «По созданию» (birthtime-*) предпочитает headerDate — дату из первой строки
// файла (`date: YYYY-MM-DD HH:MM:SS`), и только при её отсутствии падает на
// birthtime из Finder. Папки headerDate не имеют (0) → между собой сортируются по
// birthtime, что и нужно. См. backend readHeaderDate в electron/main.js.
const creationKey = (n) => n.headerDate || n.birthtime || 0
export function getSortComparator(sortMode) {
  return (a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    switch (sortMode) {
      case 'name-desc': return b.name.localeCompare(a.name)
      case 'mtime-desc': return (b.mtime || 0) - (a.mtime || 0)
      case 'mtime-asc': return (a.mtime || 0) - (b.mtime || 0)
      case 'birthtime-desc': return creationKey(b) - creationKey(a)
      case 'birthtime-asc': return creationKey(a) - creationKey(b)
      default: return a.name.localeCompare(b.name)
    }
  }
}

// Recursively sort a tree (entries carry `children` arrays) in place-free style.
// Returns a new array; child arrays are re-sorted at every level. Used to apply
// the user's sortMode to the recursive IPC payload (which arrives in default
// folder-first/name order).
export function sortTreeDeep(nodes, sortMode) {
  const cmp = getSortComparator(sortMode)
  const walk = (arr) => {
    const sorted = [...arr].sort(cmp)
    return sorted.map(n => (Array.isArray(n.children) ? { ...n, children: walk(n.children) } : n))
  }
  return Array.isArray(nodes) ? walk(nodes) : []
}
