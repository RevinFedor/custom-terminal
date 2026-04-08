import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import PragmaticFileTree from './PragmaticFileTree/PragmaticFileTree'
import { flattenTree } from './PragmaticFileTree/utils'
import IconCropper from './IconCropper'
import { getValue, setValue } from '../../utils/storage'

// --- Sort Comparator ---

const SORT_MODES = [
  { id: 'name-asc', label: 'By name (A → Z)' },
  { id: 'name-desc', label: 'By name (Z → A)' },
  { id: 'mtime-desc', label: 'By modified (newest)' },
  { id: 'mtime-asc', label: 'By modified (oldest)' },
  { id: 'birthtime-desc', label: 'By created (newest)' },
  { id: 'birthtime-asc', label: 'By created (oldest)' },
]

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

// Переименовать узел в дереве (для Rename)
const renameNodeInTree = (nodes, nodeId, newName, newId) => {
  return nodes.map(node => {
    if (node.id === nodeId) {
      return { ...node, id: newId, name: newName }
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
        movedNode = { ...node }
        // Обновляем id узла на новый путь
        const nodeName = node.name
        const newPath = newParentId ? `${newParentId}/${nodeName}` : `${rootPath}/${nodeName}`
        movedNode.id = newPath
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
  if (!newParentId) {
    // Перемещение в корень
    console.log('[dnd]','Moving to root')
    newTree = [...newTree, movedNode].sort(cmp)
  } else {
    // Перемещение в папку
    console.log('[dnd]','Moving to folder:', newParentId)
    const insertIntoParent = (nodes) => {
      return nodes.map(node => {
        if (node.id === newParentId) {
          const children = node.children ? [...node.children, movedNode] : [movedNode]
          children.sort(cmp)
          console.log('[dnd]','Inserted into parent, new children count:', children.length)
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

  return newTree
}

// --- Main Component ---

// Save custom icons to storage (async)
async function saveCustomIcons(icons) {
  await setValue('gt-file-icons', icons)
}

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
              <button
                key={i}
                className="icon-picker-item"
                onClick={() => onSelect(img)}
                title="Reuse icon"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <img src={img} width={20} height={20} alt="" style={{ borderRadius: 3, objectFit: 'cover' }} />
              </button>
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

function ContextMenu({ x, y, node, onClose, onCopyPath, onCopyContent, onRename, onChooseIcon, onNewFile, onNewFolder, onDelete, multiSelectCount = 0 }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handleRenameClick = () => {
    console.log('[sidebar]','ContextMenu: Rename clicked for node:', node ? { id: node.id, name: node.name } : null)
    onRename(node)
    onClose()
  }

  const handleNewFileClick = (targetNode) => {
    console.log('[sidebar]','ContextMenu: New File clicked, targetNode:', targetNode ? { id: targetNode.id } : 'ROOT')
    onNewFile(targetNode)
    onClose()
  }

  const handleNewFolderClick = (targetNode) => {
    console.log('[sidebar]','ContextMenu: New Folder clicked, targetNode:', targetNode ? { id: targetNode.id } : 'ROOT')
    onNewFolder(targetNode)
    onClose()
  }

  return (
    <div ref={menuRef} className="context-menu" style={{ left: x, top: y }}>
      {node && (
        <>
          <div className="context-menu-item" onClick={() => { onCopyPath(node.id); onClose() }}>Copy Path</div>
          {!node.isDirectory && (
            <div className="context-menu-item" onClick={() => { onCopyContent(node.id); onClose() }}>Copy Content</div>
          )}
          {multiSelectCount <= 1 && (
            <div className="context-menu-item" onClick={handleRenameClick}>Rename</div>
          )}
          {multiSelectCount <= 1 && !node.isDirectory && (
            <div className="context-menu-item" onClick={() => { onChooseIcon(node); onClose() }}>Choose Icon</div>
          )}
          {multiSelectCount <= 1 && node.isDirectory && (
            <>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleNewFileClick(node)}>New File</div>
              <div className="context-menu-item" onClick={() => handleNewFolderClick(node)}>New Folder</div>
            </>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-item context-menu-item-delete" onClick={() => { onDelete(node.id); onClose() }}>
            {multiSelectCount > 1 ? `Delete ${multiSelectCount} items` : 'Delete'}
          </div>
        </>
      )}
      {!node && (
        <>
          <div className="context-menu-item" onClick={() => handleNewFileClick(null)}>New File</div>
          <div className="context-menu-item" onClick={() => handleNewFolderClick(null)}>New Folder</div>
        </>
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
}) {
  const [treeData, setTreeData] = useState([])
  const [contextMenu, setContextMenu] = useState(null)
  const [customIcons, setCustomIcons] = useState({}) // Loaded async from storage
  const [iconPickerNode, setIconPickerNode] = useState(null)
  const [editingId, setEditingId] = useState(null) // ID of node being edited
  const [dirDropdownOpen, setDirDropdownOpen] = useState(false)
  const [sortMode, setSortMode] = useState('name-asc')
  const [autoReveal, setAutoReveal] = useState(true)
  const openStatesMapRef = useRef({}) // Per-directory expanded state
  const sortModeRef = useRef('name-asc') // For use in callbacks
  const [focusedId, setFocusedId] = useState(null) // ID of node with focus border (VS Code style)
  const [multiSelected, setMultiSelected] = useState(new Set()) // Multi-selection (Cmd+Click, Shift+Click)
  const lastClickedRef = useRef(null) // Anchor for Shift+Click range selection
  const undoStackRef = useRef([]) // Undo stack for delete operations
  const openStateRef = useRef(initialExpandedDirs || {}) // Store expanded state
  const [expandedSnapshot, setExpandedSnapshot] = useState({}) // Triggers PragmaticFileTree update

  // macOS Finder style: Enter on selected file → rename mode
  useEffect(() => {
    if (!sidebarFocused || editingId) {
      console.log('[sidebar] Enter-to-rename listener SKIPPED (sidebarFocused:', sidebarFocused, 'editingId:', editingId, ')')
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
  }, [sidebarFocused, editingId, activeFilePath])

  // 0. Load custom icons from storage
  useEffect(() => {
    async function loadIcons() {
      const saved = await getValue('gt-file-icons', {})
      setCustomIcons(saved)
    }
    loadIcons()
  }, [])

  // 0.3. Load per-directory settings (sort, autoReveal) when folderPath changes
  useEffect(() => {
    if (!folderPath) return
    async function loadDirSettings() {
      const allSettings = await getValue('gt-dir-settings', {})
      const s = allSettings[folderPath] || {}
      const mode = s.sortMode || 'name-asc'
      setSortMode(mode)
      sortModeRef.current = mode
      setAutoReveal(s.autoReveal !== false)
    }
    loadDirSettings()
  }, [folderPath])

  // 0.5. Save/restore expanded state when folderPath changes
  const prevFolderPathRef = useRef(null)
  useEffect(() => {
    if (prevFolderPathRef.current) {
      openStatesMapRef.current[prevFolderPathRef.current] = { ...openStateRef.current }
    }
    setTreeData([])
    // On first mount, use initialExpandedDirs if available and no in-memory state
    if (!prevFolderPathRef.current && initialExpandedDirs && !openStatesMapRef.current[folderPath]) {
      openStateRef.current = { ...initialExpandedDirs }
    } else {
      openStateRef.current = openStatesMapRef.current[folderPath] || {}
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
    if (!sidebarFocused) return
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
  }, [sidebarFocused, handleUndo])

  // Debounced save of expanded dirs to DB
  const saveExpandedTimerRef = useRef(null)
  const saveExpandedDirs = useCallback((state) => {
    if (!onExpandedDirsChange) return
    if (saveExpandedTimerRef.current) clearTimeout(saveExpandedTimerRef.current)
    saveExpandedTimerRef.current = setTimeout(() => {
      onExpandedDirsChange(state)
    }, 500)
  }, [onExpandedDirsChange])

  // 1. Initial Load (when folderPath changes or hard refresh requested)
  useEffect(() => {
    if (!folderPath) return

    console.log('[sidebar]','=== TREE LOAD ===', { folderPath, externalRefreshTrigger })

    const loadTree = async () => {
      try {
        const nodes = await loadTreeRecursive(folderPath, openStateRef.current)
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
        let cleaned = false
        for (const key of Object.keys(openStateRef.current)) {
          if (!allDirPaths.has(key)) {
            delete openStateRef.current[key]
            cleaned = true
          }
        }
        if (cleaned) saveExpandedDirs(openStateRef.current)
        setTreeData(nodes)
        setExpandedSnapshot({ ...openStateRef.current })
      } catch (err) {
        console.log('[sidebar]','Error loading tree:', err)
      }
    }

    loadTree()
  }, [folderPath, externalRefreshTrigger, loadTreeRecursive, saveExpandedDirs])

  // Sync expansion state from PragmaticFileTree
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
      setExpandedSnapshot({ ...openStateRef.current }) // Новая ссылка → PragmaticFileTree обновит expandedIds
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
      return
    }

    // Если дети уже загружены, не грузим заново
    if (node.children && node.children.length > 0) {
      console.log('[tree]','Children already loaded, count:', node.children.length)
      return
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
    } catch (e) {
      console.log('[tree]','Error loading children:', e)
    }
  }, [treeData])

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
        if (onRename) onRename(id, newPath)
        setTreeData(prev => renameNodeInTree(prev, id, trimmedName, newPath))
      } else {
        console.log('[sidebar]','ERROR: Rename failed!')
      }
    }
  }, [onRename, registerPendingOperation, folderPath])

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
    if (!sidebarFocused) return
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
  }, [sidebarFocused, handleDelete, multiSelected, focusedId])

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

  const handleFileSelect = useCallback((path, isDirectory, modifiers = {}) => {
    // Skip placeholder nodes — they're not real files
    if (path.startsWith('__new__')) return

    const { metaKey, shiftKey } = modifiers
    setFocusedId(path)

    if (metaKey) {
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
      // Shift+Click: range select in visible order
      const visible = flattenTree(treeData, openStateRef.current)
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
    if (!isDirectory) onFileSelect(path, isDirectory)
  }, [onFileSelect, treeData])

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
      const newIcons = { ...customIcons, [iconPickerNode.data.name]: icon }
      setCustomIcons(newIcons)
      await saveCustomIcons(newIcons)
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
      className={`sidebar ${sidebarFocused ? 'focused' : ''}`}
      style={{ width, '--sidebar-font-size': `${fontSize}px` }}
      onMouseDown={onFocus}
    >
      {/* Draggable область для traffic lights - двойной клик разворачивает окно */}
      <div className="sidebar-drag-region" />

      <div className="sidebar-header">
        <div
          className={`sidebar-title ${dirDropdownOpen ? 'open' : ''}`}
          onClick={() => { setDirDropdownOpen(!dirDropdownOpen) }}
        >
          <span>{folderPath?.split('/').pop()}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" className="sidebar-title-chevron">
            <path d={dirDropdownOpen ? "M2 6L5 3L8 6" : "M2 4L5 7L8 4"} stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
        {/* New File */}
        <button className="sidebar-toolbar-btn" onClick={() => handleNewFile(getTargetParentNode())} title="New file">
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M9.5 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V4.5L9.5 1z" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </button>
        {/* New Folder */}
        <button className="sidebar-toolbar-btn" onClick={() => handleNewFolder(getTargetParentNode())} title="New folder">
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 3.5h4.5l1.5 1.5H14v8H2z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round"/><path d="M8 7.5v3M6.5 9h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </button>
        {/* Add directory */}
        <button className="sidebar-toolbar-btn" onClick={onAddDirectory} title="Add directory">
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        {/* Collapse sidebar */}
        <button className="sidebar-toolbar-btn sidebar-collapse-btn" onClick={onCollapse} title="Collapse sidebar">
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M2 2v12M6 4l-3 4 3 4M7 2h7v12H7" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {dirDropdownOpen && (
          <div className="directory-dropdown">
            {directories.map(dir => (
              <div
                key={dir}
                className={`directory-item ${dir === folderPath ? 'active' : ''}`}
                onClick={() => { onSwitchDirectory(dir); setDirDropdownOpen(false) }}
              >
                <span className="directory-item-name">{dir.split('/').pop()}</span>
                <button
                  className="directory-item-remove"
                  onClick={(e) => { e.stopPropagation(); onRemoveDirectory(dir) }}
                  title="Remove"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
          ))}
          </div>
        )}

      </div>

      <div
        className="file-tree"
        onPointerDown={(e) => { onFocus(e); setFocusedId(null); setMultiSelected(new Set()); setDirDropdownOpen(false) }}
        onContextMenu={(e) => { e.preventDefault(); setFocusedId(null); setMultiSelected(new Set()); setContextMenu({ x: e.clientX, y: e.clientY, node: null }) }}
      >
        {treeData.length > 0 && (
          <PragmaticFileTree
             treeData={treeData}
             folderPath={folderPath}
             onFileSelect={handleFileSelect}
             activeFilePath={activeFilePath}
             customIcons={customIcons}
             iconTheme={iconTheme}
             settings={settings}
             onContextMenu={handleContextMenu}
             onRename={onRename} // For moves
             onToggle={handleToggle}
             onExpandChange={handleExpandChange}
             initialExpanded={expandedSnapshot}
             
             // Editing props
             editingId={editingId}
             onCommitRename={handleCommitRename}
             onCancelRename={handleCancelRename}
             sidebarFocused={sidebarFocused}
             focusedId={focusedId}
             multiSelected={multiSelected}
          />
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onClose={() => setContextMenu(null)}
          onCopyPath={(p) => window.require('electron').clipboard.writeText(p)}
          onCopyContent={async (p) => {
            const content = await window.electronAPI.readFile(p)
            if (content !== null) window.require('electron').clipboard.writeText(content)
          }}
          onRename={(node) => setEditingId(node.id)}
          onChooseIcon={setIconPickerNode}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onDelete={handleDelete}
          multiSelectCount={multiSelected.size}
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
              setCustomIcons(newIcons);
              await saveCustomIcons(newIcons);
              setIconPickerNode(null);
          }}
          onResetToVsc={async () => {
              const newIcons = { ...customIcons, [iconPickerNode.name]: 'vscode' };
              setCustomIcons(newIcons);
              await saveCustomIcons(newIcons);
              setIconPickerNode(null);
          }}
          existingIcons={[
            ...Object.values(customIcons || {}).filter(v => v?.startsWith?.('data:')),
            ...(settings?.customIconRules || []).map(r => r.image).filter(Boolean)
          ]}
        />
      )}
    </aside>
  )
}

export default Sidebar