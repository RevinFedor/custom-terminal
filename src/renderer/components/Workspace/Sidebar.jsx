import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { MessageSquareQuote } from 'lucide-react'
import {
  applySidebarLayout,
  DEFAULT_FILE_ICON_PROFILE,
  emptySidebarLayout,
  FileExplorerContextMenu,
  FileOutlineExplorer,
  flattenTree,
  hasSidebarLayoutEntries,
  mutateSharedFileIconProfile,
  normalizeFileIconProfile,
  normalizeSidebarLayout,
  rewriteSidebarLayoutPath,
  sameFileIconProfile,
  sameSidebarLayout,
  shouldImportLegacyFileIconOverrides,
} from '@noted/file-explorer'
import '@noted/file-explorer/styles.css'
import '@noted/file-explorer/context-menu.css'
import Tooltip from '../UI/Tooltip'
import ControlHint from '../UI/ControlHint'
import IconCropper from './IconCropper'
import { RunAfterTabPicker } from './RunAfterTabPicker'
import { useWorkspaceStore } from '../../store/useWorkspaceStore'
import { useUIStore } from '../../store/useUIStore'
import { getValue, setValue } from '../../utils/storage'
import { linkedFileSessionChipSnapshot } from '../../utils/linkedFileSessionChips.mjs'
import { useCommandHierarchyHint } from '../../hooks/useCommandHierarchyHint'

const CUSTOM_TERMINAL_ICON_IMPORT_KEY = import.meta.env.DEV
  ? 'customTerminalDevelopment'
  : 'customTerminalProduction'

const SESSION_CHIP_COLORS = {
  claude: '#DA7756',
  codex: '#10A37F',
  gemini: '#4E86F8',
  default: '#A78BFA',
}

const GT_FILE_TRANSFER_CLIPBOARD_FORMAT = 'application/x-gt-editor-file-transfer-v1'

// --- Sort Comparator ---

const SORT_MODES = [
  { id: 'name-asc', label: 'By name (A → Z)' },
  { id: 'name-desc', label: 'By name (Z → A)' },
  { id: 'mtime-desc', label: 'By modified (newest)' },
  { id: 'mtime-asc', label: 'By modified (oldest)' },
  { id: 'birthtime-desc', label: 'By created (newest)' },
  { id: 'birthtime-asc', label: 'By created (oldest)' },
]

function isRunAfterPickerEvent(e) {
  const selector = '[data-run-after-picker-menu], [data-run-after-picker-portal]'
  const target = e.target
  if (target instanceof Element && target.closest(selector)) return true
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  return path.some((node) => node instanceof Element && node.matches(selector))
}

function getSortComparator(sortMode) {
  return (a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    switch (sortMode) {
      case 'name-desc': return b.name.localeCompare(a.name)
      case 'mtime-desc': return (b.mtime || 0) - (a.mtime || 0)
      case 'mtime-asc': return (a.mtime || 0) - (b.mtime || 0)
      case 'birthtime-desc': return (b.birthtime || 0) - (a.birthtime || 0)
      case 'birthtime-asc': return (a.birthtime || 0) - (b.birthtime || 0)
      default: return a.name.localeCompare(b.name)
    }
  }
}

// --- Helpers for Immutable Tree Updates ---

// Вставить узел в дерево (для New File/Folder)
const insertNodeIntoTree = (nodes, parentId, newNode, sortComparator) => {
  const cmp = sortComparator || getSortComparator('name-asc')
  if (!parentId) {
    return [...nodes, newNode].sort(cmp)
  }

  return nodes.map(node => {
    if (node.id === parentId) {
      const children = node.children ? [...node.children, newNode] : [newNode]
      children.sort(cmp)
      return { ...node, children }
    }
    if (node.children) {
      return { ...node, children: insertNodeIntoTree(node.children, parentId, newNode, sortComparator) }
    }
    return node
  })
}

// Удалить узел из дерева (для Delete)
const removeNodeFromTree = (nodes, nodeId) => {
  return nodes
    .filter(node => node.id !== nodeId)
    .map(node => {
      if (node.children) {
        return { ...node, children: removeNodeFromTree(node.children, nodeId) }
      }
      return node
    })
}

const rewriteNodePath = (node, oldBase, newBase) => {
  const nextId = node.id === oldBase || node.id.startsWith(oldBase + '/')
    ? newBase + node.id.slice(oldBase.length)
    : node.id
  return {
    ...node,
    id: nextId,
    children: node.children
      ? node.children.map(child => rewriteNodePath(child, oldBase, newBase))
      : node.children
  }
}

const findTreeNodeById = (nodes, id) => {
  if (!id) return null
  for (const node of nodes || []) {
    if (node.id === id) return node
    const found = findTreeNodeById(node.children, id)
    if (found) return found
  }
  return null
}

const rewritePathWithMap = (value, pathMap) => {
  if (!value || !pathMap || pathMap.size === 0) return value
  let bestOldPath = null
  for (const oldPath of pathMap.keys()) {
    if (value === oldPath || value.startsWith(oldPath + '/')) {
      if (!bestOldPath || oldPath.length > bestOldPath.length) bestOldPath = oldPath
    }
  }
  if (!bestOldPath) return value
  return pathMap.get(bestOldPath) + value.slice(bestOldPath.length)
}

const rewriteExpandedStatePaths = (state, pathMap) => {
  const next = {}
  for (const [path, expanded] of Object.entries(state || {})) {
    const nextPath = rewritePathWithMap(path, pathMap)
    next[nextPath] = !!(next[nextPath] || expanded)
  }
  return next
}

const rewriteSidebarLayoutPaths = (layout, pathMap) => {
  let next = normalizeSidebarLayout(layout)
  for (const [oldPath, newPath] of pathMap) {
    next = rewriteSidebarLayoutPath(next, oldPath, newPath)
  }
  return next
}

// Переименовать узел в дереве (для Rename)
const renameNodeInTree = (nodes, nodeId, newName, newId) => {
  return nodes.map(node => {
    if (node.id === nodeId) {
      return { ...rewriteNodePath(node, nodeId, newId), name: newName }
    }
    if (node.children) {
      return { ...node, children: renameNodeInTree(node.children, nodeId, newName, newId) }
    }
    return node
  })
}

// Переместить узел в дереве (для Move/Drag&Drop)
const moveNodeInTree = (nodes, nodeId, newParentId, rootPath, sortComparator) => {
  console.log('[dnd]','moveNodeInTree called:', { nodeId, newParentId, rootPath })

  // 1. Найти и извлечь узел
  let movedNode = null

  const extractNode = (nodes) => {
    return nodes.filter(node => {
      if (node.id === nodeId) {
        const nodeName = node.name
        const newPath = newParentId ? `${newParentId}/${nodeName}` : `${rootPath}/${nodeName}`
        movedNode = rewriteNodePath(node, nodeId, newPath)
        console.log('[dnd]','Extracted node:', { oldId: nodeId, newId: newPath })
        return false // Удаляем из текущего места
      }
      return true
    }).map(node => {
      if (node.children) {
        return { ...node, children: extractNode(node.children) }
      }
      return node
    })
  }

  let newTree = extractNode(nodes)
  console.log('[dnd]','Tree after extraction:', { movedNode, treeSize: newTree.length })

  if (!movedNode) {
    console.log('[dnd]','ERROR: Node not found for move')
    return nodes
  }

  // 2. Вставить узел в новое место
  const cmp = sortComparator || getSortComparator('name-asc')
  let inserted = false
  if (!newParentId) {
    // Перемещение в корень
    console.log('[dnd]','Moving to root')
    newTree = [...newTree, movedNode].sort(cmp)
    inserted = true
  } else {
    // Перемещение в папку
    console.log('[dnd]','Moving to folder:', newParentId)
    const insertIntoParent = (nodes) => {
      return nodes.map(node => {
        if (node.id === newParentId) {
          const children = node.children ? [...node.children, movedNode] : [movedNode]
          children.sort(cmp)
          console.log('[dnd]','Inserted into parent, new children count:', children.length)
          inserted = true
          return { ...node, children }
        }
        if (node.children) {
          return { ...node, children: insertIntoParent(node.children) }
        }
        return node
      })
    }
    newTree = insertIntoParent(newTree)
  }

  if (!inserted) {
    console.log('[dnd]','ERROR: Move parent not found, restoring original tree')
    return nodes
  }

  return newTree
}

// --- Main Component ---

function IconPicker({ item, onSelect, onClose, onReset, onResetToVsc, existingIcons }) {
  const pickerRef = useRef(null)
  const fileInputRef = useRef(null)
  const [cropperSrc, setCropperSrc] = useState(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        if (!cropperSrc) onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose, cropperSrc])

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setCropperSrc(reader.result)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleCropDone = (base64) => {
    setCropperSrc(null)
    onSelect(base64)
  }

  // Collect unique images from existing icon rules for quick reuse
  const recentIcons = useMemo(() => {
    const seen = new Set()
    const icons = []
    for (const img of (existingIcons || [])) {
      if (img && !seen.has(img)) {
        seen.add(img)
        icons.push(img)
      }
    }
    return icons
  }, [existingIcons])

  return (
    <div className="icon-picker-overlay">
      <div ref={pickerRef} className="icon-picker">
        <div className="icon-picker-header">
          <span>Icon for {item.name}</span>
          <button className="icon-picker-close" onClick={onClose}>✕</button>
        </div>

        <div className="icon-picker-upload" style={{ padding: '12px', borderBottom: recentIcons.length ? '1px solid var(--border)' : 'none' }}>
          <button
            className="icon-picker-upload-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.6">
              <path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
              <path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/>
            </svg>
            Upload Image
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleFileSelect}
          />
        </div>

        {recentIcons.length > 0 && (
          <div className="icon-picker-grid">
            {recentIcons.map((img, i) => (
              <Tooltip key={i} content="Reuse icon">
              <button
                className="icon-picker-item"
                onClick={() => onSelect(img)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <img src={img} width={20} height={20} alt="" style={{ borderRadius: 3, objectFit: 'cover' }} />
              </button>
              </Tooltip>
            ))}
          </div>
        )}

        <div className="icon-picker-footer">
          <button className="icon-picker-reset" onClick={onReset}>
            Reset (Smart Rules)
          </button>
          <button className="icon-picker-reset vsc-reset" onClick={onResetToVsc} style={{ marginTop: '8px' }}>
            Reset (VS Code)
          </button>
        </div>
      </div>

      {cropperSrc && (
        <IconCropper
          imageSrc={cropperSrc}
          onCrop={handleCropDone}
          onCancel={() => setCropperSrc(null)}
        />
      )}
    </div>
  )
}

function Sidebar({
  folderPath,
  directories = [],
  onAddDirectory,
  onRemoveDirectory,
  onSwitchDirectory,
  onChangeDirectory,
  directoryChangeState = 'idle',
  onFileSelect,
  selectedPaths = [],
  setSelectedPaths,
  setLastSelectedPath,
  setFocusedOnRoot,
  focusedOnRoot,
  activeFilePath,
  onRename,
  onDelete,
  width = 260,
  confirmDelete = false,
  fontSize = 13,
  iconTheme,
  settings,
  externalRefreshTrigger = 0,
  sidebarFocused = false,
  onFocus,
  registerPendingOperation = () => {}, // Callback для игнорирования FileWatcher
  disableDrag = false, // New prop to disable internal DnD
  onCollapse,
  initialExpandedDirs,
  onExpandedDirsChange,
  initialScrollTop = 0,
  onScrollChange,
  linkOwnerProjectId = null,
  onLinkFile,
}) {
  const showToast = useUIStore((state) => state.showToast)
  const linkedFileSessionSnapshot = useWorkspaceStore(useCallback((state) => {
    const workspace = linkOwnerProjectId
      ? state.openProjects.get(linkOwnerProjectId)
      : null
    return linkedFileSessionChipSnapshot(workspace?.tabs)
  }, [linkOwnerProjectId]))
  const linkedFileSessionsByPath = useMemo(() => {
    const byPath = new Map()
    let chips = []
    try {
      chips = JSON.parse(linkedFileSessionSnapshot)
    } catch {}
    for (const chip of chips) {
      const existing = byPath.get(chip.filePath) || []
      existing.push(chip)
      byPath.set(chip.filePath, existing)
    }
    return byPath
  }, [linkedFileSessionSnapshot])
  const [projectPromptUsageByPath, setProjectPromptUsageByPath] = useState(() => new Map())
  const [treeData, setTreeData] = useState([])
  const [contextMenu, setContextMenu] = useState(null)
  const [fileIconProfile, setFileIconProfile] = useState(() => (
    normalizeFileIconProfile({
      ...DEFAULT_FILE_ICON_PROFILE,
      iconTheme,
      customIconRules: settings?.customIconRules,
    })
  ))
  const fileIconProfileRef = useRef(fileIconProfile)
  const fileIconRevisionRef = useRef(0)
  const fileIconWriteQueueRef = useRef(Promise.resolve())
  const customIcons = fileIconProfile.nameOverrides
  const effectiveIconTheme = fileIconProfile.iconTheme
  const effectiveIconSettings = useMemo(() => ({
    ...(settings || {}),
    customIconRules: fileIconProfile.customIconRules,
  }), [fileIconProfile.customIconRules, settings])
  const [iconPickerNode, setIconPickerNode] = useState(null)
  const [editingId, setEditingId] = useState(null) // ID of node being edited
  const [dirDropdownOpen, setDirDropdownOpen] = useState(false)
  const [sortMode, setSortMode] = useState('name-asc')
  const [autoReveal, setAutoReveal] = useState(true)
  const openStatesMapRef = useRef({}) // Per-directory expanded state
  const sortModeRef = useRef('name-asc') // For use in callbacks
  const [focusedId, setFocusedId] = useState(null) // ID of node with focus border (VS Code style)
  const [localSidebarFocused, setLocalSidebarFocused] = useState(false)
  const sidebarRef = useRef(null)
  useCommandHierarchyHint(sidebarRef)
  const effectiveSidebarFocused = sidebarFocused || localSidebarFocused
  const [multiSelected, setMultiSelected] = useState(new Set()) // Multi-selection (Cmd+Click, Shift+Click)
  const lastClickedRef = useRef(null) // Anchor for Shift+Click range selection
  const transferPasteBusyRef = useRef(false)
  const undoStackRef = useRef([]) // Undo stack for delete operations
  const openStateRef = useRef(initialExpandedDirs || {}) // Store expanded state
  const [expandedSnapshot, setExpandedSnapshot] = useState({}) // Triggers FileOutlineExplorer update
  const [sidebarLayout, setSidebarLayout] = useState(() => emptySidebarLayout())
  const sidebarLayoutRef = useRef(sidebarLayout)
  const sidebarLayoutRevisionRef = useRef(0)
  const treeDataRef = useRef([])

  useEffect(() => {
    if (!folderPath) {
      setProjectPromptUsageByPath(new Map())
      return
    }
    let cancelled = false
    const ipc = window.require('electron').ipcRenderer
    const refresh = async () => {
      try {
        const result = await ipc.invoke('project-prompts:usage-for-root', folderPath)
        if (cancelled || !result?.success) return
        const next = new Map()
        for (const usage of result.data || []) {
          if (usage?.path) next.set(usage.path, Array.isArray(usage.projects) ? usage.projects : [])
        }
        setProjectPromptUsageByPath(next)
      } catch (error) {
        console.warn('[ProjectPrompts] sidebar usage refresh failed:', error?.message || error)
      }
    }
    const onChanged = () => { void refresh() }
    void refresh()
    ipc.on('project-prompts:changed', onChanged)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      ipc.removeListener('project-prompts:changed', onChanged)
      window.removeEventListener('focus', refresh)
    }
  }, [folderPath])

  const adoptFileIconResult = useCallback((result) => {
    if (!result) return
    const profile = normalizeFileIconProfile(result.profile)
    fileIconRevisionRef.current = Number(result.revision) || 0
    fileIconProfileRef.current = profile
    setFileIconProfile(previous => sameFileIconProfile(previous, profile) ? previous : profile)
  }, [])

  const commitFileIconMutation = useCallback((mutation) => {
    const run = async () => {
      const ipc = window.require('electron').ipcRenderer
      const result = await mutateSharedFileIconProfile({
        get: () => ipc.invoke('shared-file-icons:get', 'default'),
        put: (profile, expectedRevision) => (
          ipc.invoke('shared-file-icons:put', profile, expectedRevision, 'default')
        ),
      }, mutation, {
        revision: fileIconRevisionRef.current,
        profile: fileIconProfileRef.current,
      })
      adoptFileIconResult(result)
      return result
    }
    const queued = fileIconWriteQueueRef.current.then(run, run)
    fileIconWriteQueueRef.current = queued.catch(() => null)
    return queued
  }, [adoptFileIconResult])

  const commitCustomIcons = useCallback((nameOverrides) => (
    commitFileIconMutation(profile => ({ ...profile, nameOverrides }))
  ), [commitFileIconMutation])

  useEffect(() => {
    treeDataRef.current = treeData
  }, [treeData])

  useEffect(() => {
    setLocalSidebarFocused(true)
    const frame = requestAnimationFrame(() => {
      try { sidebarRef.current?.focus({ preventScroll: true }) } catch {}
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    sidebarLayoutRef.current = sidebarLayout
  }, [sidebarLayout])

  const updateSidebarLayout = useCallback((updater, options = {}) => {
    setSidebarLayout(previous => {
      const base = normalizeSidebarLayout(previous)
      const next = normalizeSidebarLayout(typeof updater === 'function' ? updater(base) : updater)
      if (sameSidebarLayout(base, next)) return previous
      window.require('electron').ipcRenderer
        .invoke('shared-file-layout:put', folderPath, next, sidebarLayoutRevisionRef.current)
        .then(result => {
          if (!result) return
          sidebarLayoutRevisionRef.current = Number(result.revision) || 0
          if (result.conflict) setSidebarLayout(normalizeSidebarLayout(result.layout))
        })
        .catch(error => console.error('[SidebarLayout] shared persist failed:', error))
      return next
    })
    if (options.activateManualOrder && sortModeRef.current !== 'manual') {
      sortModeRef.current = 'manual'
      setSortMode('manual')
    }
  }, [folderPath])

  useEffect(() => {
    if (!folderPath) {
      sidebarLayoutRevisionRef.current = 0
      setSidebarLayout(emptySidebarLayout())
      return
    }
    let cancelled = false
    const ipc = window.require('electron').ipcRenderer
    const refresh = async () => {
      try {
        const result = await ipc.invoke('shared-file-layout:get', folderPath)
        if (cancelled || !result) return
        const revision = Number(result.revision) || 0
        if (revision === sidebarLayoutRevisionRef.current) return
        sidebarLayoutRevisionRef.current = revision
        const next = normalizeSidebarLayout(result.layout)
        setSidebarLayout(previous => sameSidebarLayout(previous, next) ? previous : next)
        if (hasSidebarLayoutEntries(next) && sortModeRef.current !== 'manual') {
          sortModeRef.current = 'manual'
          setSortMode('manual')
        }
      } catch (error) {
        console.error('[SidebarLayout] shared load failed:', error)
      }
    }
    refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 1200)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [folderPath])

  // macOS Finder style: Enter on selected file → rename mode
  useEffect(() => {
    if (!effectiveSidebarFocused || editingId) {
      console.log('[sidebar] Enter-to-rename listener SKIPPED (sidebarFocused:', effectiveSidebarFocused, 'editingId:', editingId, ')')
      return
    }
    console.log('[sidebar] Enter-to-rename listener ATTACHED (activeFilePath:', activeFilePath, ')')
    const handleKeyDown = (e) => {
      // Skip if event comes from an input (e.g. rename input that bubbled through)
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      console.log('[sidebar] Document keydown:', e.key, 'activeFilePath:', activeFilePath, 'target:', e.target.tagName, e.target.className)
      if (e.key === 'Enter' && activeFilePath) {
        e.preventDefault()
        console.log('[sidebar] >>> ENTER-TO-RENAME FIRED, setting editingId to:', activeFilePath)
        setEditingId(activeFilePath)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      console.log('[sidebar] Enter-to-rename listener REMOVED')
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [effectiveSidebarFocused, editingId, activeFilePath])

  // Shared icon profile. Only the installed app may import its old exact-name
  // overrides; disposable dev state must never seed cross-application data.
  useEffect(() => {
    let cancelled = false
    const ipc = window.require('electron').ipcRenderer
    const api = {
      get: () => ipc.invoke('shared-file-icons:get', 'default'),
      put: (profile, expectedRevision) => (
        ipc.invoke('shared-file-icons:put', profile, expectedRevision, 'default')
      ),
    }
    const refresh = async () => {
      try {
        let result = await api.get()
        const current = normalizeFileIconProfile(result?.profile)
        const shouldImportLegacyIcons = shouldImportLegacyFileIconOverrides(
          current,
          CUSTOM_TERMINAL_ICON_IMPORT_KEY,
        )
        if (shouldImportLegacyIcons) {
          const legacyNameOverrides = await getValue('gt-file-icons', {})
          result = await mutateSharedFileIconProfile(api, profile => ({
            ...profile,
            nameOverrides: {
              ...(legacyNameOverrides || {}),
              ...profile.nameOverrides,
            },
            legacyImports: {
              ...profile.legacyImports,
              [CUSTOM_TERMINAL_ICON_IMPORT_KEY]: true,
            },
          }), result)
        }
        if (cancelled || !result) return
        if (
          (Number(result.revision) || 0) === fileIconRevisionRef.current
          && sameFileIconProfile(result.profile, fileIconProfileRef.current)
        ) return
        adoptFileIconResult(result)
      } catch (error) {
        console.error('[SharedFileIcons] load failed:', error)
      }
    }
    refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 1200)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [adoptFileIconResult])

  // 0.3. Load per-directory settings (sort, autoReveal) when folderPath changes
  useEffect(() => {
    if (!folderPath) return
    async function loadDirSettings() {
      const ipc = window.require('electron').ipcRenderer
      const [allSettings, sharedLayoutResult] = await Promise.all([
        getValue('gt-dir-settings', {}),
        ipc.invoke('shared-file-layout:get', folderPath).catch(() => null),
      ])
      const s = allSettings[folderPath] || {}
      const mode = hasSidebarLayoutEntries(sharedLayoutResult?.layout)
        ? 'manual'
        : (s.sortMode || 'name-asc')
      setSortMode(mode)
      sortModeRef.current = mode
      setAutoReveal(s.autoReveal !== false)
    }
    loadDirSettings()
  }, [folderPath])

  // 0.5. Save/restore expanded state when folderPath changes.
  // Two memories hold the expanded folders: the durable one from the project
  // record (survives restart, arrives as initialExpandedDirs) and a per-path
  // in-memory map that keeps state while the user hops between tab folders.
  // The durable one is NOT a first-mount privilege: re-entering a project
  // remounts this component, and treating that as "no saved state" collapsed
  // every folder — and then wrote the empty result back over the saved one.
  const prevFolderPathRef = useRef(null)
  // Read through a ref, never a dependency: the durable state arrives as a new
  // object on every save, and depending on it would blank and reload the whole
  // tree twice a second while the user expands folders.
  const initialExpandedDirsRef = useRef(initialExpandedDirs)
  initialExpandedDirsRef.current = initialExpandedDirs
  useEffect(() => {
    if (prevFolderPathRef.current) {
      openStatesMapRef.current[prevFolderPathRef.current] = { ...openStateRef.current }
    }
    setTreeData([])
    const remembered = openStatesMapRef.current[folderPath]
    const durable = initialExpandedDirsRef.current
    // Prefer whatever the user expanded during this component's lifetime, and
    // fall back to the durable state. An empty in-memory entry must never win
    // over saved folders — that is the collapse the user sees on return.
    if (remembered && Object.keys(remembered).length > 0) {
      openStateRef.current = remembered
    } else if (durable && Object.keys(durable).length > 0) {
      openStateRef.current = { ...durable }
    } else {
      openStateRef.current = remembered || {}
    }
    prevFolderPathRef.current = folderPath
  }, [folderPath]);

  // Функция для рекурсивной загрузки дерева с учётом открытых папок
  // Загружает детей для папок которые были открыты, чтобы initialOpenState работал
  const loadTreeRecursive = useCallback(async (dirPath, openState) => {
    const items = await window.electronAPI.readDirectory(dirPath)
    const nodes = []

    for (const item of items) {
      const node = {
        id: item.path,
        name: item.name,
        isDirectory: item.isDirectory,
        mtime: item.mtime || 0,
        birthtime: item.birthtime || 0,
        children: item.isDirectory ? [] : undefined
      }

      // Если папка была открыта — загружаем её детей рекурсивно
      if (item.isDirectory && openState[item.path]) {
        try {
          node.children = await loadTreeRecursive(item.path, openState)
        } catch (e) {
          console.log('[tree]','Error loading children for', item.path, e)
          node.children = []
        }
      }

      nodes.push(node)
    }

    // Сортировка по текущему режиму
    nodes.sort(getSortComparator(sortModeRef.current))


    return nodes
  }, [])

  useEffect(() => {
    const releaseFocusOutside = (event) => {
      const target = event.target
      if (sidebarRef.current && target instanceof Node && sidebarRef.current.contains(target)) return
      setLocalSidebarFocused(false)
    }
    document.addEventListener('pointerdown', releaseFocusOutside, true)
    return () => document.removeEventListener('pointerdown', releaseFocusOutside, true)
  }, [])

  // Cmd+Z: Undo delete in sidebar
  const handleUndo = useCallback(async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) return

    console.log('[sidebar] Undo delete:', entry.path)

    registerPendingOperation(entry.path)
    const parentDir = entry.path.substring(0, entry.path.lastIndexOf('/'))
    registerPendingOperation(parentDir)

    const success = await window.electronAPI.restoreFromUndo(entry)
    if (success) {
      const nodes = await loadTreeRecursive(folderPath, openStateRef.current)
      setTreeData(nodes)
      setExpandedSnapshot({ ...openStateRef.current })
      console.log('[sidebar] Undo restore success:', entry.path)
    } else {
      undoStackRef.current.push(entry)
      console.log('[sidebar] Undo restore failed:', entry.path)
    }
  }, [folderPath, loadTreeRecursive, registerPendingOperation])

  useEffect(() => {
    if (!effectiveSidebarFocused) return
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        if (undoStackRef.current.length > 0) {
          e.preventDefault()
          e.stopPropagation()
          console.log('[sidebar] Cmd+Z: undo delete')
          handleUndo()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [effectiveSidebarFocused, handleUndo])

  // Debounced save of expanded dirs to DB
  const saveExpandedTimerRef = useRef(null)
  const saveExpandedDirs = useCallback((state) => {
    if (!onExpandedDirsChange) return
    if (saveExpandedTimerRef.current) clearTimeout(saveExpandedTimerRef.current)
    saveExpandedTimerRef.current = setTimeout(() => {
      onExpandedDirsChange(state)
    }, 500)
  }, [onExpandedDirsChange])

  // A GT Editor handoff is intentionally consumed only while the file sidebar
  // owns focus. Normal Cmd+V keeps flowing to xterm/SDK when the sidebar is not
  // the active surface.
  useEffect(() => {
    if (!effectiveSidebarFocused || !folderPath) return
    const handleTransferPaste = async (event) => {
      if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'v') return
      if (editingId || transferPasteBusyRef.current) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return

      const electron = window.require('electron')
      let ticketBuffer = null
      try { ticketBuffer = electron.clipboard.readBuffer(GT_FILE_TRANSFER_CLIPBOARD_FORMAT) } catch {}
      if (!ticketBuffer || ticketBuffer.length === 0) return

      event.preventDefault()
      event.stopPropagation()
      transferPasteBusyRef.current = true
      const focusedNode = findTreeNodeById(treeDataRef.current, focusedId)
      const destinationDir = focusedNode?.isDirectory
        ? focusedNode.id
        : (focusedNode?.id ? focusedNode.id.substring(0, focusedNode.id.lastIndexOf('/')) : folderPath)
      try {
        const result = await electron.ipcRenderer.invoke('gt-editor-transfer:paste', { destinationDir })
        if (!result?.success) {
          showToast(result?.error || 'Не удалось перенести файл из GT Editor', 'error')
          return
        }
        if (result.oldPath && result.newPath && result.oldPath !== result.newPath) {
          onRename?.(result.oldPath, result.newPath)
        }
        const parentPath = result.newPath?.substring(0, result.newPath.lastIndexOf('/'))
        if (parentPath && parentPath !== folderPath) {
          openStateRef.current[parentPath] = true
          setExpandedSnapshot({ ...openStateRef.current })
          saveExpandedDirs(openStateRef.current)
        }
        const nodes = await loadTreeRecursive(folderPath, openStateRef.current)
        setTreeData(nodes)
        setFocusedId(result.newPath || null)
        showToast(`Файл перенесён: ${result.displayName || result.newPath?.split('/').pop() || 'готово'}`, 'success')
      } catch (error) {
        showToast(`Не удалось перенести файл: ${error?.message || error}`, 'error')
      } finally {
        transferPasteBusyRef.current = false
      }
    }
    document.addEventListener('keydown', handleTransferPaste, true)
    return () => document.removeEventListener('keydown', handleTransferPaste, true)
  }, [editingId, effectiveSidebarFocused, focusedId, folderPath, loadTreeRecursive, onRename, saveExpandedDirs, showToast])

  // 1. Initial Load (when folderPath changes or hard refresh requested)
  useEffect(() => {
    if (!folderPath) return

    console.log('[sidebar]','=== TREE LOAD ===', { folderPath, externalRefreshTrigger })
    let cancelled = false

    const loadTree = async () => {
      try {
        const nodes = await loadTreeRecursive(folderPath, openStateRef.current)
        if (cancelled) return
        console.log('[sidebar]','Tree loaded, root items:', nodes.length)
        // Clean stale entries: keep only paths that exist in the loaded tree
        const allDirPaths = new Set()
        const collectDirs = (items) => {
          for (const n of items) {
            if (n.isDirectory) {
              allDirPaths.add(n.id)
              if (n.children) collectDirs(n.children)
            }
          }
        }
        collectDirs(nodes)
        const knownBefore = Object.keys(openStateRef.current).length
        let cleaned = false
        for (const key of Object.keys(openStateRef.current)) {
          if (!allDirPaths.has(key)) {
            delete openStateRef.current[key]
            cleaned = true
          }
        }
        // Losing EVERY remembered folder at once means this tree is rooted
        // somewhere else, not that the user deleted all of them — persisting it
        // would overwrite the project's saved folders with nothing. Dropping
        // them from this render is fine; writing that emptiness back is not.
        const wipedEverything = cleaned
          && knownBefore > 0
          && Object.keys(openStateRef.current).length === 0
        if (cleaned && !wipedEverything) saveExpandedDirs(openStateRef.current)
        if (wipedEverything) {
          console.log('[sidebar]','Skipped saving cleared expand-state — root mismatch', { folderPath, knownBefore })
        }
        setTreeData(nodes)
        setExpandedSnapshot({ ...openStateRef.current })
      } catch (err) {
        if (cancelled) return
        console.log('[sidebar]','Error loading tree:', err)
      }
    }

    loadTree()
    return () => { cancelled = true }
  }, [folderPath, externalRefreshTrigger, loadTreeRecursive, saveExpandedDirs])

  // Sync expansion state from the shared outline explorer.
  const handleExpandChange = useCallback((newExpandedState) => {
      openStateRef.current = newExpandedState;
      saveExpandedDirs(newExpandedState);
  }, [saveExpandedDirs]);

  // Auto-reveal: раскрываем parent-папки когда activeFilePath меняется
  useEffect(() => {
    if (!autoReveal) return
    if (!activeFilePath || !folderPath || !activeFilePath.startsWith(folderPath + '/')) return

    const parts = activeFilePath.slice(folderPath.length + 1).split('/')
    parts.pop() // Убираем имя файла
    if (parts.length === 0) return // Файл в корне — раскрывать нечего

    let currentPath = folderPath
    const parentPaths = []
    for (const part of parts) {
      currentPath += '/' + part
      parentPaths.push(currentPath)
    }

    // Помечаем все parent-папки как раскрытые
    let changed = false
    for (const p of parentPaths) {
      if (!openStateRef.current[p]) changed = true
      openStateRef.current[p] = true
    }

    if (!changed) return // Все parent-папки уже раскрыты И дети уже загружены

    // Загружаем дерево с раскрытыми папками (все дети загружены ДО setState)
    loadTreeRecursive(folderPath, openStateRef.current).then(nodes => {
      setTreeData(nodes)
      setExpandedSnapshot({ ...openStateRef.current }) // Новая ссылка обновляет controlled expansion state.
      saveExpandedDirs(openStateRef.current)
    }).catch(err => {
      console.log('[sidebar]','Error revealing file in tree:', err)
    })
  }, [activeFilePath, folderPath, loadTreeRecursive])

  // 2. Lazy Loading Children
  const handleToggle = useCallback(async (id) => {
    console.log('[tree]','handleToggle:', id)
    
    // Find node in treeData (recursive search)
    const findNode = (nodes) => {
        for (const node of nodes) {
            if (node.id === id) return node;
            if (node.children) {
                const found = findNode(node.children);
                if (found) return found;
            }
        }
        return null;
    }

    const node = findNode(treeData);

    if (!node || !node.isDirectory) {
      console.log('[tree]','Toggle skipped: not a directory or not found')
      return { ok: false, reason: 'not-directory' }
    }

    // Если дети уже загружены, не грузим заново
    if (node.children && node.children.length > 0) {
      console.log('[tree]','Children already loaded, count:', node.children.length)
      return { ok: true, childCount: node.children.length }
    }

    console.log('[tree]','Loading children for:', id)
    try {
      const items = await window.electronAPI.readDirectory(id)
      const children = items.map(item => ({
        id: item.path,
        name: item.name,
        isDirectory: item.isDirectory,
        mtime: item.mtime || 0,
        birthtime: item.birthtime || 0,
        children: item.isDirectory ? [] : undefined
      })).sort(getSortComparator(sortModeRef.current))
      console.log('[tree]','Children loaded, count:', children.length)

      setTreeData(prevData => {
        const updateNode = (nodes) => {
          return nodes.map(n => {
            if (n.id === id) return { ...n, children }
            if (n.children) return { ...n, children: updateNode(n.children) }
            return n
          })
        }
        return updateNode(prevData)
      })
      return { ok: true, childCount: children.length }
    } catch (e) {
      console.log('[tree]','Error loading children:', e)
      return { ok: false, reason: 'read-failed', error: e?.message || String(e) }
    }
  }, [treeData])

  const handleMoveItems = useCallback(async (sourcePaths, destinationDir, meta = {}) => {
    if (!folderPath || !destinationDir || !Array.isArray(sourcePaths)) return []
    if (destinationDir !== folderPath && !destinationDir.startsWith(folderPath + '/')) {
      console.log('[SidebarDnd]', 'Move rejected: destination is outside the sidebar root', destinationDir)
      return []
    }

    const requested = [...new Set(sourcePaths.filter(Boolean))]
    const uniquePaths = requested.filter(sourcePath => (
      !requested.some(otherPath => otherPath !== sourcePath && sourcePath.startsWith(otherPath + '/'))
    ))
    const moveCandidates = uniquePaths.map(sourcePath => {
      const slash = sourcePath.lastIndexOf('/')
      const sourceParent = slash > 0 ? sourcePath.slice(0, slash) : folderPath
      const fileName = slash >= 0 ? sourcePath.slice(slash + 1) : sourcePath
      return { sourcePath, sourceParent, fileName, newPath: `${destinationDir}/${fileName}` }
    })
    const destinationOwners = new Map()
    const duplicateDestinations = new Set()
    for (const { sourcePath, newPath } of moveCandidates) {
      if (destinationOwners.has(newPath)) {
        duplicateDestinations.add(newPath)
      } else {
        destinationOwners.set(newPath, sourcePath)
      }
    }
    if (duplicateDestinations.size > 0) {
      console.log('[SidebarDnd]', 'Move rejected: duplicate destination in batch', {
        destinationDir,
        duplicateDestinations: [...duplicateDestinations],
      })
      return moveCandidates.map(({ sourcePath, newPath }) => ({
        sourcePath,
        newPath,
        skipped: true,
        success: false,
        reason: 'duplicate-destination',
      }))
    }

    const results = []
    const entries = []

    for (const { sourcePath, sourceParent, fileName, newPath } of moveCandidates) {
      if (!fileName || sourceParent === destinationDir || sourcePath === newPath) {
        results.push({ sourcePath, newPath, skipped: true, success: true, reason: 'same-parent' })
        continue
      }
      if (!sourcePath.startsWith(folderPath + '/') || destinationDir === sourcePath || destinationDir.startsWith(sourcePath + '/')) {
        results.push({ sourcePath, newPath, skipped: true, success: false, reason: 'invalid-destination' })
        continue
      }
      if (!findTreeNodeById(treeDataRef.current, sourcePath)) {
        results.push({ sourcePath, newPath, skipped: true, success: false, reason: 'source-not-in-tree' })
        continue
      }

      let sourceExists = null
      let destinationExists = null
      let targetExists = null
      try {
        const exists = await window.electronAPI.pathsExist([sourcePath, destinationDir, newPath])
        sourceExists = !!exists?.[sourcePath]
        destinationExists = !!exists?.[destinationDir]
        targetExists = !!exists?.[newPath]
      } catch (error) {
        console.log('[SidebarDnd]', 'Path preflight unavailable:', error)
      }
      const rejectReason = sourceExists === false
        ? 'source-missing'
        : (destinationExists === false ? 'destination-missing' : (targetExists === true ? 'target-exists' : null))
      if (rejectReason) {
        console.log('[SidebarDnd]', `Move rejected: ${rejectReason}`, { sourcePath, destinationDir, newPath })
        results.push({ sourcePath, newPath, skipped: true, success: false, reason: rejectReason })
        continue
      }

      entries.push({ sourcePath, sourceParent, newPath })
    }

    if (entries.length === 0) return results

    if (results.some(result => result.success === false)) {
      for (const entry of entries) {
        results.push({
          sourcePath: entry.sourcePath,
          newPath: entry.newPath,
          skipped: true,
          success: false,
          reason: 'batch-preflight-failed',
        })
      }
      return results
    }

    const pathMap = new Map(entries.map(entry => [entry.sourcePath, entry.newPath]))

    for (const entry of entries) {
      registerPendingOperation(entry.sourcePath)
      registerPendingOperation(entry.sourceParent)
      registerPendingOperation(destinationDir)
      registerPendingOperation(entry.newPath)
    }

    const previewLayout = normalizeSidebarLayout(meta?.action?.layout || sidebarLayoutRef.current)
    const finalLayout = rewriteSidebarLayoutPaths(previewLayout, pathMap)
    let batchResult = null
    try {
      batchResult = await window.electronAPI.moveItemsAtomic({
        rootPath: folderPath,
        moves: entries.map(entry => ({
          sourcePath: entry.sourcePath,
          destinationPath: entry.newPath,
        })),
        finalLayout,
        expectedRevision: sidebarLayoutRevisionRef.current,
      })
    } catch (error) {
      batchResult = {
        committed: false,
        reason: 'ipc-failed',
        failure: { message: error?.message || String(error) },
        moves: [],
      }
    }

    console.log('[SidebarDnd]', 'Atomic move result:', {
      count: entries.length,
      committed: !!batchResult?.committed,
      rolledBack: !!batchResult?.rolledBack,
      partial: !!batchResult?.partial,
      reason: batchResult?.reason || 'unknown',
    })

    if (!batchResult?.committed) {
      if (batchResult?.conflict && batchResult?.layoutResult?.layout) {
        const serverLayout = normalizeSidebarLayout(batchResult.layoutResult.layout)
        sidebarLayoutRevisionRef.current = Number(batchResult.layoutResult.revision) || 0
        sidebarLayoutRef.current = serverLayout
        setSidebarLayout(serverLayout)
      }

      if (batchResult?.partial) {
        const actualPathMap = new Map()
        for (const move of batchResult.moves || []) {
          if (move?.actualPath === move?.destinationPath) {
            actualPathMap.set(move.sourcePath, move.destinationPath)
          }
        }
        if (actualPathMap.size > 0) {
          for (const [sourcePath, newPath] of actualPathMap) onRename?.(sourcePath, newPath)
          const recoveredExpandedState = rewriteExpandedStatePaths(openStateRef.current, actualPathMap)
          openStateRef.current = recoveredExpandedState
          openStatesMapRef.current[folderPath] = { ...recoveredExpandedState }
          setExpandedSnapshot({ ...recoveredExpandedState })
          updateSidebarLayout(previous => rewriteSidebarLayoutPaths(previous, actualPathMap))
          saveExpandedDirs(recoveredExpandedState)
        }
        const nodes = await loadTreeRecursive(folderPath, openStateRef.current)
        treeDataRef.current = nodes
        setTreeData(nodes)
      }

      const reason = batchResult?.preflightErrors?.[0]?.code || batchResult?.reason || 'move-failed'
      for (const entry of entries) {
        results.push({ sourcePath: entry.sourcePath, newPath: entry.newPath, success: false, reason })
      }
      return results
    }

    const committedLayout = normalizeSidebarLayout(batchResult.layoutResult?.layout || finalLayout)
    sidebarLayoutRevisionRef.current = Number(batchResult.layoutResult?.revision) || sidebarLayoutRevisionRef.current
    sidebarLayoutRef.current = committedLayout
    const newParentId = destinationDir === folderPath ? null : destinationDir
    const nextExpandedState = rewriteExpandedStatePaths(openStateRef.current, pathMap)
    let committedTree = treeDataRef.current
    for (const entry of entries) {
      committedTree = moveNodeInTree(
        committedTree,
        entry.sourcePath,
        newParentId,
        folderPath,
        getSortComparator(sortModeRef.current)
      )
    }

    flushSync(() => {
      treeDataRef.current = committedTree
      setTreeData(committedTree)
      setFocusedId(previous => rewritePathWithMap(previous, pathMap))
      setMultiSelected(previous => new Set(
        [...(previous || [])].map(id => rewritePathWithMap(id, pathMap))
      ))
      openStateRef.current = nextExpandedState
      openStatesMapRef.current[folderPath] = { ...nextExpandedState }
      setExpandedSnapshot({ ...nextExpandedState })
      setSidebarLayout(committedLayout)
      for (const entry of entries) onRename?.(entry.sourcePath, entry.newPath)
    })
    saveExpandedDirs(nextExpandedState)

    if (sortModeRef.current !== 'manual') {
      sortModeRef.current = 'manual'
      setSortMode('manual')
    }

    if (typeof meta.onOptimisticMove === 'function') {
      meta.onOptimisticMove(entries.map(entry => entry.newPath))
    }

    for (const entry of entries) {
      results.push({ sourcePath: entry.sourcePath, newPath: entry.newPath, success: true })
    }

    const nodes = await loadTreeRecursive(folderPath, openStateRef.current)
    treeDataRef.current = nodes
    setTreeData(nodes)

    return results
  }, [folderPath, loadTreeRecursive, onRename, registerPendingOperation, saveExpandedDirs, updateSidebarLayout])

  // 4. Handle Rename (or Create for new items)
  const handleCommitRename = useCallback(async (node, newName) => {
    console.log('[sidebar]','=== handleCommitRename START ===', { id: node.id, newName, isNew: node.isNew, isDirectory: node.isDirectory, parentPath: node.parentPath })
    console.log('[sidebar]','Current editingId before clear:', editingId)

    setEditingId(null); // Exit edit mode

    const id = node.id;
    const isNewItem = node.isNew === true;
    const trimmedName = newName.trim();

    // Extract name without extension for cancel check
    const nameWithoutExt = trimmedName.replace(/\.[^.]+$/, '');

    // If name is empty or default dash - cancel creation/revert rename
    if (!trimmedName || !nameWithoutExt || nameWithoutExt === '—' || nameWithoutExt === '-') {
      console.log('[sidebar]','Empty/default name, cancelling', { trimmedName, nameWithoutExt })
      if (isNewItem) {
        setTreeData(prev => removeNodeFromTree(prev, id))
      }
      return
    }

    if (isNewItem) {
      // === CREATE NEW FILE/FOLDER ===
      const parentPath = node.parentPath
      // Name comes with extension from input (e.g. "my-file.md")
      // Auto-add .md only if no extension provided
      let finalName = trimmedName
      if (!node.isDirectory && !trimmedName.includes('.')) {
        finalName = trimmedName + '.md'
      }
      const newPath = `${parentPath}/${finalName}`
      console.log('[sidebar]','Creating new item:', { parentPath, finalName, newPath, isDirectory: node.isDirectory })

      // Register for FileWatcher ignore
      registerPendingOperation(newPath)
      registerPendingOperation(parentPath)

      let success = false
      if (node.isDirectory) {
        success = await window.electronAPI.createFolder(newPath)
      } else {
        success = await window.electronAPI.createFile(newPath)
      }

      console.log('[sidebar]','Create result:', success)

      if (success) {
        // Replace placeholder with real node
        setTreeData(prev => {
          const withoutPlaceholder = removeNodeFromTree(prev, id)
          const realNode = {
            id: newPath,
            name: finalName,
            isDirectory: node.isDirectory,
            children: node.isDirectory ? [] : undefined
          }
          const parentId = parentPath === folderPath ? null : parentPath
          return insertNodeIntoTree(withoutPlaceholder, parentId, realNode, getSortComparator(sortModeRef.current))
        })
      } else {
        // Creation failed - remove placeholder and show error
        console.log('[sidebar]','ERROR: Create failed!')
        setTreeData(prev => removeNodeFromTree(prev, id))
      }
    } else {
      // === RENAME EXISTING FILE/FOLDER ===
      const dir = id.substring(0, id.lastIndexOf('/'))
      const newPath = `${dir}/${trimmedName}`
      console.log('[sidebar]','Renaming:', { from: id, to: newPath })

      // Don't rename if name unchanged
      if (id.endsWith('/' + trimmedName)) {
        console.log('[sidebar]','Name unchanged, skipping')
        return
      }

      registerPendingOperation(id)
      registerPendingOperation(newPath)
      registerPendingOperation(dir)

      const success = await window.electronAPI.renameFile(id, newPath)
      console.log('[sidebar]','Rename result:', success)

      if (success) {
        const pathMap = new Map([[id, newPath]])
        const nextExpandedState = rewriteExpandedStatePaths(openStateRef.current, pathMap)
        onRename?.(id, newPath)
        setTreeData(prev => renameNodeInTree(prev, id, trimmedName, newPath))
        setFocusedId(previous => rewritePathWithMap(previous, pathMap))
        setMultiSelected(previous => {
          const next = new Set()
          for (const selectedId of previous || []) next.add(rewritePathWithMap(selectedId, pathMap))
          return next
        })
        openStateRef.current = nextExpandedState
        openStatesMapRef.current[folderPath] = { ...nextExpandedState }
        setExpandedSnapshot({ ...nextExpandedState })
        updateSidebarLayout(previous => rewriteSidebarLayoutPaths(previous, pathMap))
        saveExpandedDirs(nextExpandedState)
      } else {
        console.log('[sidebar]','ERROR: Rename failed!')
      }
    }
  }, [onRename, registerPendingOperation, folderPath, saveExpandedDirs, updateSidebarLayout])

  const handleCancelRename = useCallback((node) => {
      setEditingId(null);
      if (node.isNew) {
          setTreeData(prev => removeNodeFromTree(prev, node.id));
      }
  }, []);

  // 5. Handle Delete (Move to Trash + Undo stack)
  const handleDeleteSingle = useCallback(async (path) => {
    if (!path) return

    // Ghost placeholder node — just remove from tree, not on disk
    if (path.startsWith('__new__')) {
      setTreeData(prev => removeNodeFromTree(prev, path))
      return
    }

    const undoData = await window.electronAPI.readFileForUndo(path)

    const parentDir = path.substring(0, path.lastIndexOf('/'))
    registerPendingOperation(path)
    registerPendingOperation(parentDir)

    const success = await window.electronAPI.deletePath(path)
    if (success) {
      console.log('[sidebar] Deleted (to Trash):', path)
      if (undoData) {
        undoStackRef.current.push({ ...undoData, path })
        if (undoStackRef.current.length > 20) undoStackRef.current.shift()
      }
      if (onDelete) onDelete(path)
      setTreeData(prev => removeNodeFromTree(prev, path))
    }
  }, [onDelete, registerPendingOperation])

  // Delete handler: deletes all multi-selected or single path
  const handleDelete = useCallback(async (path) => {
    const pathsToDelete = multiSelected.size > 1 ? [...multiSelected] : [path]
    for (const p of pathsToDelete) {
      await handleDeleteSingle(p)
    }
    setMultiSelected(new Set())
  }, [multiSelected, handleDeleteSingle])

  // Delete/Backspace key handler
  useEffect(() => {
    if (!effectiveSidebarFocused) return
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
        e.preventDefault()
        if (multiSelected.size > 0) {
          handleDelete(null)
        } else if (focusedId) {
          handleDelete(focusedId)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [effectiveSidebarFocused, handleDelete, multiSelected, focusedId])

  // Helper: clean up any existing __new__ placeholders
  const cleanupPlaceholders = useCallback(() => {
    setEditingId(null)
    setTreeData(prev => {
      const clean = (nodes) => nodes
        .filter(n => !n.id.startsWith('__new__'))
        .map(n => n.children ? { ...n, children: clean(n.children) } : n)
      return clean(prev)
    })
  }, [])

  // 6. Handle New File - show placeholder first, create on submit
  const handleNewFile = useCallback(async (parentNode) => {
    console.log('[sidebar]','=== handleNewFile START ===')

    // Clean up any existing placeholder (prevents ghost nodes)
    cleanupPlaceholders()

    const isRoot = !parentNode
    const parentPath = isRoot ? folderPath : parentNode.id
    console.log('[sidebar]','isRoot:', isRoot, 'parentPath:', parentPath)

    if (!parentPath) return

    // Ensure parent is open (data + visual)
    if (!isRoot && parentNode) {
        await handleToggle(parentNode.id);
        // Expand folder visually (data already loaded by handleToggle)
        openStateRef.current[parentPath] = true
        setExpandedSnapshot(prev => ({ ...prev, [parentPath]: true }))
    }

    // Create placeholder node (NOT on disk yet!)
    const tempId = `__new__${Date.now()}`
    const placeholderNode = {
      id: tempId,
      name: '', // Empty name shows placeholder
      isDirectory: false,
      isNew: true, // Flag: not created on disk yet
      parentPath: parentPath,
      children: undefined
    }

    console.log('[sidebar]','Adding placeholder:', placeholderNode)
    const insertParentId = isRoot ? null : parentPath
    setTreeData(prev => insertNodeIntoTree(prev, insertParentId, placeholderNode, getSortComparator(sortModeRef.current)))

    // Start editing
    setEditingId(tempId);

    console.log('[sidebar]','=== handleNewFile END ===')
  }, [folderPath, handleToggle, cleanupPlaceholders])

  // 7. Handle New Folder - show placeholder first, create on submit
  const handleNewFolder = useCallback(async (parentNode) => {
    console.log('[sidebar]','=== handleNewFolder START ===')

    // Clean up any existing placeholder (prevents ghost nodes)
    cleanupPlaceholders()

    const isRoot = !parentNode
    const parentPath = isRoot ? folderPath : parentNode.id

    if (!parentPath) return

    if (!isRoot && parentNode) {
        await handleToggle(parentNode.id);
        // Expand folder visually (data already loaded by handleToggle)
        openStateRef.current[parentPath] = true
        setExpandedSnapshot(prev => ({ ...prev, [parentPath]: true }))
    }

    // Create placeholder node (NOT on disk yet!)
    const tempId = `__new__${Date.now()}`
    const placeholderNode = {
      id: tempId,
      name: '', // Empty name shows placeholder
      isDirectory: true,
      isNew: true, // Flag: not created on disk yet
      parentPath: parentPath,
      children: []
    }

    console.log('[sidebar]','Adding folder placeholder:', placeholderNode)
    const insertParentId = isRoot ? null : parentPath
    setTreeData(prev => insertNodeIntoTree(prev, insertParentId, placeholderNode, getSortComparator(sortModeRef.current)))

    // Start editing
    setEditingId(tempId);

    console.log('[sidebar]','=== handleNewFolder END ===')
  }, [folderPath, handleToggle, cleanupPlaceholders])

  const handleSelect = useCallback((nodes) => {
    // Adapter for legacy select if needed, but we pass onFileSelect directly
  }, [])

  const renderLinkedSessionChips = useCallback(({ row, isFolder }) => {
    if (isFolder) return null
    const chips = linkedFileSessionsByPath.get(row.id) || []
    const promptProjects = projectPromptUsageByPath.get(row.id) || []
    if (chips.length === 0 && promptProjects.length === 0) return null
    // Slightly larger than the old half-size: at fontSize/2 the session name
    // was unreadable next to the file name it annotates.
    const chipFontSize = Math.max(7, Math.round(fontSize / 2) + 1)
    return (
      <div
        className="file-row-session-chips-wrap"
        data-no-outline-drag
        data-outline-dnd-ignore
        onClick={event => event.stopPropagation()}
      >
      <div
        className="file-row-project-chips file-row-session-chips"
        data-no-outline-drag
        data-outline-dnd-ignore
      >
        {promptProjects.map(project => (
          <span
            key={`prompt-${project.id}`}
            className="file-row-project-chip file-row-session-chip file-row-prompt-chip"
            data-project-prompt-chip={project.id}
            data-no-outline-drag
            data-outline-dnd-ignore
            title={`Проектный промпт Custom Terminal · ${project.name}`}
            style={{
              fontSize: chipFontSize,
              lineHeight: 1.3,
              ['--file-session-chip-accent']: '#a78bfa99',
              ['--file-session-chip-bg']: '#8b5cf633',
              ['--file-session-chip-bg-hover']: '#8b5cf633',
            }}
          >
            <MessageSquareQuote size={Math.max(8, chipFontSize + 1)} strokeWidth={2} aria-hidden="true" />
            <span>{project.name}</span>
          </span>
        ))}
        {chips.map(chip => {
          const accent = SESSION_CHIP_COLORS[chip.sessionKind] || SESSION_CHIP_COLORS.default
          return (
            <button
              key={chip.sessionTabId}
              type="button"
              className="file-row-project-chip file-row-session-chip"
              data-file-session-chip={chip.sessionTabId}
              data-session-kind={chip.sessionKind}
              data-no-outline-drag
              data-outline-dnd-ignore
              title={`Открыть сессию «${chip.sessionName}»`}
              // Only typography and the session tint are inline; the tab-like
              // box (radius, border, padding) and the placement under the file
              // live in sidebar.css. The alpha steps mirror TAB_COLORS so a
              // chip reads as the same object as the tab it opens.
              style={{
                fontSize: chipFontSize,
                lineHeight: 1.3,
                ['--file-session-chip-accent']: `${accent}99`,
                ['--file-session-chip-bg']: `${accent}33`,
                ['--file-session-chip-bg-hover']: `${accent}55`,
              }}
              onClick={async event => {
                event.stopPropagation()
                if (!linkOwnerProjectId) return
                const opened = await useWorkspaceStore.getState().openTabById(chip.sessionTabId, {
                  projectId: linkOwnerProjectId, reason: 'file-session-chip',
                })
                if (!opened) return
              }}
            >
              {chip.sessionName}
            </button>
          )
        })}
      </div>
      {chips.length > 1 && (
        // Pinned total, outside the scroller: with the strip scrolled the user
        // otherwise cannot tell whether one more session is hidden or ten. It
        // shows the full count (not "+N hidden"), because that number stays
        // true at every scroll position — a remainder would change as the
        // strip moves and would have to be recomputed on every scroll frame.
        <span
          className="file-row-session-chips-count"
          data-no-outline-drag
          data-outline-dnd-ignore
          title={`${chips.length} сессий у файла:\n${chips.map(c => `• ${c.sessionName}`).join('\n')}`}
          style={{ fontSize: chipFontSize }}
        >
          {chips.length}
        </span>
      )}
      </div>
    )
  }, [fontSize, linkOwnerProjectId, linkedFileSessionsByPath, projectPromptUsageByPath])

  const handleFileSelect = useCallback((path, isDirectory, modifiers = {}) => {
    // Skip placeholder nodes — they're not real files
    if (path.startsWith('__new__')) {
      console.warn('[SidebarFileTree] select-skip-placeholder', { path, isDirectory, modifiers })
      return
    }

    const { metaKey, shiftKey } = modifiers
    console.warn('[SidebarFileTree] select', {
      path,
      isDirectory,
      metaKey: !!metaKey,
      shiftKey: !!shiftKey,
      multiSelected: multiSelected.size,
    })
    setFocusedId(path)

    if (metaKey) {
      console.warn('[SidebarFileTree] select-meta-toggle', { path })
      // Cmd+Click: toggle item in selection
      setMultiSelected(prev => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
      lastClickedRef.current = path
      return // Don't open file
    }

    if (shiftKey && lastClickedRef.current) {
      console.warn('[SidebarFileTree] select-shift-range', { path, anchor: lastClickedRef.current })
      // Shift+Click: range select in visible order
      const visibleTree = applySidebarLayout(treeData, sidebarLayout, folderPath, sortMode)
      const visible = flattenTree(visibleTree, openStateRef.current)
      const anchorIdx = visible.findIndex(n => n.id === lastClickedRef.current)
      const targetIdx = visible.findIndex(n => n.id === path)
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const from = Math.min(anchorIdx, targetIdx)
        const to = Math.max(anchorIdx, targetIdx)
        const rangePaths = new Set()
        for (let i = from; i <= to; i++) {
          rangePaths.add(visible[i].id)
        }
        setMultiSelected(rangePaths)
      }
      return // Don't open file
    }

    // Normal click: clear multi-selection, single select + open
    setMultiSelected(new Set())
    lastClickedRef.current = path
    if (!isDirectory) {
      console.warn('[SidebarFileTree] open-file', { path })
      onFileSelect(path, isDirectory)
    } else {
      console.warn('[SidebarFileTree] directory-selected-no-open', { path })
    }
  }, [folderPath, multiSelected.size, onFileSelect, sidebarLayout, sortMode, treeData])

  const handleContextMenu = useCallback((e, node) => {
    setFocusedId(node?.id || null)
    // If right-clicking on an item NOT in multi-selection, reset selection to just this item
    if (node && !multiSelected.has(node.id)) {
      setMultiSelected(new Set())
    }
    setContextMenu({ x: e.clientX, y: e.clientY, node })
  }, [multiSelected])

  const handleIconSelect = async (icon) => {
    if (iconPickerNode) {
      const newIcons = { ...customIcons, [iconPickerNode.name]: icon }
      await commitCustomIcons(newIcons)
      setIconPickerNode(null)
    }
  }

  // --- Toolbar handlers ---

  const saveDirSetting = useCallback(async (key, value) => {
    if (!folderPath) return
    const allSettings = await getValue('gt-dir-settings', {})
    allSettings[folderPath] = { ...allSettings[folderPath], [key]: value }
    await setValue('gt-dir-settings', allSettings)
  }, [folderPath])


  const handleCollapseAll = useCallback(() => {
    openStateRef.current = {}
    setExpandedSnapshot({})
    saveExpandedDirs({})
    // Reload tree without any open folders
    if (folderPath) {
      loadTreeRecursive(folderPath, {}).then(nodes => {
        setTreeData(nodes)
      })
    }
  }, [folderPath, loadTreeRecursive, saveExpandedDirs])

  const handleToggleAutoReveal = useCallback(async () => {
    const next = !autoReveal
    setAutoReveal(next)
    await saveDirSetting('autoReveal', next)
  }, [autoReveal, saveDirSetting])

  const directoryChangeBusy = directoryChangeState !== 'idle'
  const handleDirectoryTitleClick = useCallback(() => {
    if (directoryChangeBusy) return
    if (onChangeDirectory) {
      onChangeDirectory()
      return
    }
    setDirDropdownOpen(current => !current)
  }, [directoryChangeBusy, onChangeDirectory])

  // New file/folder from toolbar: use focused folder or selected item's parent
  const getTargetParentNode = useCallback(() => {
    const targetPath = focusedId || (selectedPaths && selectedPaths[0])
    if (!targetPath) return null
    // Find node in tree
    const findNode = (nodes) => {
      for (const n of nodes) {
        if (n.id === targetPath) return n
        if (n.children) { const f = findNode(n.children); if (f) return f }
      }
      return null
    }
    const node = findNode(treeData)
    if (!node) return null
    if (node.isDirectory) return node
    // File selected — find its parent folder
    const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'))
    if (parentPath === folderPath) return null // root
    return findNode(treeData) ? { id: parentPath, isDirectory: true } : null
  }, [focusedId, selectedPaths, treeData, folderPath])

  return (
    <aside
      ref={sidebarRef}
      className={`sidebar ${effectiveSidebarFocused ? 'focused' : ''}`}
      style={{ width, '--sidebar-font-size': `${fontSize}px` }}
      tabIndex={-1}
      onMouseDown={(event) => {
        setLocalSidebarFocused(true)
        onFocus?.(event)
        if (!(event.target instanceof HTMLElement) || !event.target.closest('input, textarea, [contenteditable="true"]')) {
          try { event.currentTarget.focus({ preventScroll: true }) } catch {}
        }
      }}
    >
      {/* Draggable область для traffic lights - двойной клик разворачивает окно */}
      <div className="sidebar-drag-region" />

      <div className="sidebar-header">
        <div
          className={`sidebar-title ${dirDropdownOpen && !onChangeDirectory ? 'open' : ''} ${directoryChangeBusy ? 'changing-directory' : ''}`}
          onClick={handleDirectoryTitleClick}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            handleDirectoryTitleClick()
          }}
          role="button"
          tabIndex={0}
          aria-busy={directoryChangeBusy}
          aria-disabled={directoryChangeBusy}
          data-directory-change-trigger
          data-directory-change-state={directoryChangeState}
          title={folderPath || ''}
        >
          <span>{folderPath?.split('/').pop()}</span>
          {directoryChangeBusy ? (
            <span className="sidebar-title-directory-spinner" aria-hidden="true" />
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" className="sidebar-title-chevron">
              <path d={dirDropdownOpen && !onChangeDirectory ? "M2 6L5 3L8 6" : "M2 4L5 7L8 4"} stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          )}
        </div>
        {/* New File */}
        <ControlHint label="Создать файл" side="bottom">
        <button className="sidebar-toolbar-btn" onClick={() => handleNewFile(getTargetParentNode())}>
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M9.5 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V4.5L9.5 1z" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </button>
        </ControlHint>
        {/* New Folder */}
        <ControlHint label="Создать папку" side="bottom">
        <button className="sidebar-toolbar-btn" onClick={() => handleNewFolder(getTargetParentNode())}>
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 3.5h4.5l1.5 1.5H14v8H2z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round"/><path d="M8 7.5v3M6.5 9h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </button>
        </ControlHint>
        {/* Add directory */}
        <ControlHint label="Добавить директорию" side="bottom">
        <button className="sidebar-toolbar-btn" onClick={onAddDirectory} disabled={directoryChangeBusy || !onAddDirectory}>
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        </ControlHint>
        {dirDropdownOpen && !onChangeDirectory && (
          <div className="directory-dropdown">
            {directories.map(dir => (
              <div
                key={dir}
                className={`directory-item ${dir === folderPath ? 'active' : ''}`}
                onClick={() => { onSwitchDirectory(dir); setDirDropdownOpen(false) }}
              >
                <span className="directory-item-name">{dir.split('/').pop()}</span>
                <ControlHint label="Убрать директорию" side="right">
                <button
                  className="directory-item-remove"
                  onClick={(e) => { e.stopPropagation(); onRemoveDirectory(dir) }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                </ControlHint>
              </div>
          ))}
          </div>
        )}

      </div>

      <div
        className="file-tree"
        onPointerDown={(e) => {
          setLocalSidebarFocused(true)
          onFocus?.(e)
          if (!e.target.closest('.arborist-node')) {
            setFocusedId(null)
            setMultiSelected(new Set())
          }
          setDirDropdownOpen(false)
        }}
        onContextMenu={(e) => { e.preventDefault(); setFocusedId(null); setMultiSelected(new Set()); setContextMenu({ x: e.clientX, y: e.clientY, node: null }) }}
      >
        {treeData.length > 0 && (
          <FileOutlineExplorer
             hierarchyModifier="meta"
             key={folderPath}
             treeData={treeData}
             folderPath={folderPath}
             initialScrollTop={initialScrollTop}
             onScrollChange={onScrollChange}
             onFileSelect={handleFileSelect}
             activeFilePath={activeFilePath}
             customIcons={customIcons}
             iconTheme={effectiveIconTheme}
             settings={effectiveIconSettings}
             onContextMenu={handleContextMenu}
             onRename={onRename} // For moves
             onMoveItems={handleMoveItems}
             onToggle={handleToggle}
             onExpandChange={handleExpandChange}
             initialExpanded={expandedSnapshot}
             
             // Editing props
             editingId={editingId}
             onStartRename={node => setEditingId(node.id)}
             onCommitRename={handleCommitRename}
             onCancelRename={handleCancelRename}
             sidebarFocused={effectiveSidebarFocused}
             focusedId={focusedId}
             multiSelected={multiSelected}
             sidebarLayout={sidebarLayout}
             onApplySidebarLayout={updateSidebarLayout}
             sortMode={sortMode}
             renderRowEnd={renderLinkedSessionChips}
          />
        )}
      </div>

      {contextMenu && (
        <FileExplorerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          rootPath={folderPath}
          selectedIds={multiSelected}
          onClose={() => setContextMenu(null)}
          isExternalInteraction={isRunAfterPickerEvent}
          actions={{
            copyPath: node => window.require('electron').clipboard.writeText(node.id),
            copyContent: async node => {
              const content = await window.electronAPI.readFile(node.id)
              if (content !== null) window.require('electron').clipboard.writeText(content)
            },
            copyMultiPaths: paths => {
              const sorted = [...paths].sort()
              if (sorted.length > 0) window.require('electron').clipboard.writeText(sorted.join('\n'))
            },
            copyMultiContent: async paths => {
              const parts = []
              for (const path of [...paths].sort()) {
                if (findTreeNodeById(treeDataRef.current, path)?.isDirectory) continue
                const content = await window.electronAPI.readFile(path)
                if (content !== null) parts.push(`${path}\n\n${content}`)
              }
              if (parts.length > 0) {
                window.require('electron').clipboard.writeText(parts.join('\n\n---\n\n'))
              }
            },
            rename: node => setEditingId(node.id),
            chooseIcon: setIconPickerNode,
            createFile: handleNewFile,
            createFolder: handleNewFolder,
            deleteItems: (_paths, node) => handleDelete(node?.id),
            revealInFinder: node => window.require('electron').shell.showItemInFolder(node.id),
          }}
          extensions={{
            afterCopy: ({ node, close, menuRef }) => (
              !node.isDirectory && onLinkFile ? (
                <RunAfterTabPicker
                  tabId={node.id}
                  ownerProjectId={linkOwnerProjectId}
                  autoRun={false}
                  runAfterTabId={null}
                  setRunAfterTab={(_ownerId, targetTabId) => {
                    if (!targetTabId) return
                    onLinkFile(node.id, targetTabId)
                    close()
                  }}
                  panelRef={menuRef}
                  title="Link file - pick a tab"
                  emptyLabel=""
                  showAllTabsOnOpen
                  triggerVariant="context-row"
                  triggerLabel="Link File"
                  menuWidth={252}
                  zIndex={2147482101}
                  side="right"
                  accentColor="#8b5cf6"
                  accentTextColor="#ddd6fe"
                  showRuntimeDot={false}
                  showTargetSummary={false}
                  openOnHover
                />
              ) : null
            ),
          }}
        />
      )}

      {iconPickerNode && (
        <IconPicker
          item={iconPickerNode}
          onSelect={handleIconSelect}
          onClose={() => setIconPickerNode(null)}
          onReset={async () => {
              const newIcons = { ...customIcons };
              delete newIcons[iconPickerNode.name];
              await commitCustomIcons(newIcons);
              setIconPickerNode(null);
          }}
          onResetToVsc={async () => {
              const newIcons = { ...customIcons, [iconPickerNode.name]: 'vscode' };
              await commitCustomIcons(newIcons);
              setIconPickerNode(null);
          }}
          existingIcons={[
            ...Object.values(customIcons || {}).filter(v => v?.startsWith?.('data:')),
            ...(fileIconProfile.customIconRules || []).map(r => r.image).filter(Boolean)
          ]}
        />
      )}
    </aside>
  )
}

export default Sidebar
