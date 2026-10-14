import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useOutlineDnd } from '@noted/structured-dnd/react'

import FileOutlineRow from './FileOutlineRow'
import {
  buildFileOutline,
  findOutlineLocation,
  planFileOutlineCommit,
} from './model.js'

const DND_LOG_PREFIX = '[OutlineDnd]'

function outlineNodeMap(nodes) {
  const map = new Map()
  const visit = items => {
    for (const node of items || []) {
      map.set(node.id, node)
      visit(node.children)
    }
  }
  visit(nodes)
  return map
}

function externalDropDestination(outline, rowId, rootPath) {
  if (!rowId) return rootPath
  const location = findOutlineLocation(outline, rowId)
  if (!location) return rootPath
  if (location.node.kind === 'folder') return location.node.id
  for (let index = location.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = location.ancestors[index]
    if (ancestor.kind === 'folder') return ancestor.id
  }
  return rootPath
}

export default function FileOutlineExplorer({
  treeData = [],
  folderPath,
  initialScrollTop = 0,
  hierarchyModifier = null,
  onScrollChange,
  onFileSelect,
  activeFilePath,
  customIcons,
  iconTheme,
  settings,
  onContextMenu,
  sidebarLayout,
  onApplySidebarLayout,
  onMoveItems,
  onExternalFilesDrop,
  getDroppedFilePath,
  onToggle,
  onExpandChange,
  initialExpanded = {},
  editingId,
  onStartRename,
  onCommitRename,
  onCancelRename,
  sidebarFocused,
  focusedId,
  multiSelected = new Set(),
  sortMode = 'manual',
  onRevealLink,
  renderRowEnd,
  disabled = false,
}) {
  const [expandedState, setExpandedState] = useState(() => ({ ...initialExpanded }))
  const expandedRef = useRef(expandedState)
  const expansionRequestVersionRef = useRef(new Map())
  const restoredScrollRef = useRef(false)
  const originalOutlineRef = useRef([])

  useEffect(() => {
    const next = { ...(initialExpanded || {}) }
    expandedRef.current = next
    setExpandedState(next)
  }, [initialExpanded])

  const controlledOutline = useMemo(() => buildFileOutline(treeData, {
    rootPath: folderPath,
    expandedState,
    layout: sidebarLayout,
    sortMode,
  }), [expandedState, folderPath, sidebarLayout, sortMode, treeData])
  originalOutlineRef.current = controlledOutline

  const handleHostExpansion = useCallback(async ({ nodeId, expanded, reason }) => {
    const versions = expansionRequestVersionRef.current
    const requestVersion = (versions.get(nodeId) || 0) + 1
    versions.set(nodeId, requestVersion)

    if (expanded && typeof onToggle === 'function') {
      let loadResult
      try {
        loadResult = await onToggle(nodeId)
      } catch (error) {
        if (versions.get(nodeId) !== requestVersion) return { ok: true, stale: true }
        throw error
      }
      if (versions.get(nodeId) !== requestVersion) return { ok: true, stale: true }
      if (loadResult === false || loadResult?.ok === false) return { ok: false }
    }

    if (versions.get(nodeId) !== requestVersion) return { ok: true, stale: true }

    const next = { ...expandedRef.current, [nodeId]: !!expanded }
    expandedRef.current = next
    setExpandedState(next)
    onExpandChange?.(next)
    console.log(
      DND_LOG_PREFIX,
      `expand id=${String(nodeId).split('/').pop()} expanded=${expanded ? 1 : 0} reason=${reason}`,
    )
    return { ok: true }
  }, [onExpandChange, onToggle])

  const handleCommit = useCallback(async ({
    sourceId,
    originalOutline,
    previewOutline,
    sessionId,
    reason,
  }) => {
    const plan = planFileOutlineCommit({
      originalOutline,
      previewOutline,
      sourceId,
      rootPath: folderPath,
      previousLayout: sidebarLayout,
    })

    console.log(
      DND_LOG_PREFIX,
      `session=${sessionId} commit kind=${plan.action.kind}` +
      ` source=${String(sourceId).split('/').pop()}` +
      ` destination=${String(plan.destinationFolder).split('/').pop()}` +
      ` subtree=${plan.sourceIds.length}` +
      ` physicalRoots=${plan.physicalSourceIds.length}` +
      ` reason=${reason}`,
    )

    if (!plan.requiresPhysicalMove) {
      flushSync(() => {
        onApplySidebarLayout?.(plan.layout, {
          activateManualOrder: true,
          reason: 'outline-dnd-v2',
        })
      })
      return { ok: true }
    }

    if (typeof onMoveItems !== 'function') return { ok: false }
    if (plan.physicalSourceIds.length === 0) return { ok: false }
    const results = await onMoveItems(plan.physicalSourceIds, plan.destinationFolder, {
      sessionId,
      reason: 'outline-dnd-v2',
      action: plan.action,
    })
    const resultsBySource = new Map(
      (Array.isArray(results) ? results : []).map(result => [result?.sourcePath, result]),
    )
    if (plan.physicalSourceIds.some(id => !resultsBySource.get(id)?.success)) return { ok: false }
    if (plan.expandDestination && !expandedRef.current[plan.destinationFolder]) {
      await handleHostExpansion({
        nodeId: plan.destinationFolder,
        expanded: true,
        reason: 'outline-commit',
      })
    }
    return { ok: true }
  }, [folderPath, handleHostExpansion, onApplySidebarLayout, onMoveItems, sidebarLayout])

  const dnd = useOutlineDnd({
    outline: controlledOutline,
    hierarchyModifier,
    disabled: disabled || !!editingId,
    rowHeight: 28,
    outsidePointerPolicy: 'horizontal-corridor',
    layoutAnimation: {
      duration: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      respectReducedMotion: false,
    },
    onCommit: handleCommit,
    onExpansionRequest: handleHostExpansion,
    onToggle: handleHostExpansion,
    onLog: event => {
      if (event.type === 'vertical' || event.type === 'scroll') return
      console.log(
        DND_LOG_PREFIX,
        `session=${event.sessionId || '-'} type=${event.type}`,
        event.detail,
      )
    },
  })

  useLayoutEffect(() => {
    const scroller = dnd.scrollerRef.current
    if (!scroller || restoredScrollRef.current) return
    restoredScrollRef.current = true
    scroller.scrollTop = Math.max(0, Number(initialScrollTop) || 0)
  }, [dnd.scrollerRef, initialScrollTop])

  const previewNodeMap = useMemo(
    () => outlineNodeMap(dnd.previewOutline),
    [dnd.previewOutline],
  )
  const sourceIds = useMemo(
    () => new Set(dnd.dragState?.sourceIds || []),
    [dnd.dragState?.sourceIds],
  )
  const visibleSourceIds = useMemo(
    () => dnd.rows.filter(row => sourceIds.has(row.id)).map(row => row.id),
    [dnd.rows, sourceIds],
  )
  useEffect(() => {
    const scroller = dnd.scrollerRef.current
    if (!scroller || !onExternalFilesDrop) return undefined

    const hasExternalFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')
    const handleDragOver = event => {
      if (!hasExternalFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
    }
    const handleDrop = async event => {
      if (!hasExternalFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      const rowElement = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-node-id]')
      const destination = externalDropDestination(
        dnd.previewOutline,
        rowElement?.dataset?.nodeId,
        folderPath,
      )
      const paths = Array.from(event.dataTransfer?.files || [])
        .map(file => getDroppedFilePath?.(file) || file.path || '')
        .filter(Boolean)
      if (paths.length > 0) await onExternalFilesDrop(paths, destination)
    }
    scroller.addEventListener('dragover', handleDragOver)
    scroller.addEventListener('drop', handleDrop)
    return () => {
      scroller.removeEventListener('dragover', handleDragOver)
      scroller.removeEventListener('drop', handleDrop)
    }
  }, [dnd.previewOutline, dnd.scrollerRef, folderPath, getDroppedFilePath, onExternalFilesDrop])

  return (
    <div
      ref={dnd.scrollerRef}
      className={`arborist-tree file-tree-container outline-dnd-tree ${dnd.dragState?.phase === 'dragging' ? 'is-dragging-global' : ''} ${dnd.dragState?.navigationMode ? 'is-cmd-folder-mode' : ''}`}
      data-outline-dnd-phase={dnd.dragState?.phase || undefined}
      data-outline-dnd-boundary={dnd.dragState?.boundary ?? undefined}
      data-outline-dnd-pointer-boundary={dnd.dragState?.pointerBoundary ?? undefined}
      data-outline-dnd-depth={dnd.dragState?.resolvedDepth ?? undefined}
      onScroll={event => onScrollChange?.(event.currentTarget.scrollTop)}
      onContextMenu={event => {
        if (event.target === event.currentTarget) onContextMenu?.(event, null)
      }}
    >
      <div className="outline-dnd-content">
        {dnd.rows.map(row => {
          const outlineNode = previewNodeMap.get(row.id)
          const sourceIndex = visibleSourceIds.indexOf(row.id)
          const rowProps = dnd.getRowProps(row)
          const ancestorIds = row.path.slice(0, -1)
          const parentNode = row.parentId == null ? null : previewNodeMap.get(row.parentId)
          const connectorMeta = {
            parentIsFile: parentNode?.kind === 'file',
            hasNextSibling: row.hasNextSibling,
            hasVisibleFileChildren: row.kind === 'file' && row.hasChildren,
            folderGuideDepths: ancestorIds.flatMap((ancestorId, depth) => (
              previewNodeMap.get(ancestorId)?.kind === 'folder' ? [depth] : []
            )),
            fileContinuationDepths: (row.ancestorContinuationDepths || []).filter(depth => (
              previewNodeMap.get(row.path[depth])?.kind === 'file'
            )),
          }
          return (
            <FileOutlineRow
              key={row.id}
              row={row}
              outlineNode={outlineNode}
              rowProps={rowProps}
              sourceMeta={sourceIndex >= 0 ? {
                isRoot: row.id === dnd.dragState?.sourceId,
                isFirst: sourceIndex === 0,
                isLast: sourceIndex === visibleSourceIds.length - 1,
              } : null}
              connectorMeta={connectorMeta}
              dragState={dnd.dragState}
              navigationProtected={rowProps['data-outline-dnd-navigation-protected'] === 'true'}
              expanded={row.expanded}
              onToggle={dnd.requestExpansion}
              onSelect={modifiers => onFileSelect?.(row.id, row.kind === 'folder', modifiers)}
              onStartRename={onStartRename}
              onContextMenu={onContextMenu}
              activeFilePath={activeFilePath}
              sidebarFocused={sidebarFocused}
              focusedId={focusedId}
              multiSelected={multiSelected}
              editingId={editingId}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              customIcons={customIcons}
              iconTheme={iconTheme}
              settings={settings}
              onRevealLink={onRevealLink}
              renderRowEnd={renderRowEnd}
            />
          )
        })}
        <div {...dnd.scrollSpacerProps} className="outline-dnd-scroll-reserve" />
      </div>
    </div>
  )
}
