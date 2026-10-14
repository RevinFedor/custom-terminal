import React, { useCallback, useRef } from 'react'
import { ArrowLeft, ArrowRight, CircleX, Pause } from 'lucide-react'
import FileIcon from '../FileIcon.jsx'

const ROW_INDENT_PX = 16
const ROW_BASE_PADDING_PX = 12
const ROW_CHEVRON_PX = 12
const ROW_GAP_PX = 6
const ICON_ANCHOR_PX = 16

const iconAnchorCenter = depth => (
  ROW_BASE_PADDING_PX
  + depth * ROW_INDENT_PX
  + ROW_CHEVRON_PX
  + ROW_GAP_PX
  + ICON_ANCHOR_PX / 2
)

const iconAnchorStart = depth => (
  ROW_BASE_PADDING_PX
  + depth * ROW_INDENT_PX
  + ROW_CHEVRON_PX
  + ROW_GAP_PX
)

function FolderProgress({ progress = 0, cycle = 0 }) {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  return (
    <svg
      aria-hidden="true"
      className="outline-folder-progress"
      data-cycle={cycle}
      viewBox="0 0 20 20"
    >
      <circle className="outline-folder-progress-track" cx="10" cy="10" r={radius} />
      <circle
        className="outline-folder-progress-value"
        cx="10"
        cy="10"
        r={radius}
        style={{
          strokeDasharray: circumference,
          strokeDashoffset: circumference * (1 - Math.max(0, Math.min(1, progress))),
        }}
      />
    </svg>
  )
}

function HorizontalFeedback({ feedback }) {
  if (!feedback?.direction) return null
  const progress = Math.max(0, Math.min(1, feedback.progress || 0))
  const opacity = progress > 0 ? 0.18 + progress * 0.72 : 0
  const Icon = feedback.blocked
    ? CircleX
    : feedback.direction === 'left'
      ? ArrowLeft
      : ArrowRight
  return (
    <span
      className={`outline-horizontal-feedback is-${feedback.direction} ${feedback.blocked ? 'is-blocked' : ''}`}
      data-outline-feedback={feedback.blocked ? 'stop' : feedback.direction}
      style={{ '--outline-feedback-opacity': opacity }}
    >
      <Icon size={12} strokeWidth={2} />
      {!feedback.blocked && (
        <span className="outline-horizontal-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress})` }} />
        </span>
      )}
    </span>
  )
}

export default function FileOutlineRow({
  row,
  outlineNode,
  rowProps,
  sourceMeta,
  connectorMeta,
  dragState,
  navigationProtected = false,
  expanded,
  onToggle,
  onSelect,
  onStartRename,
  onContextMenu,
  activeFilePath,
  sidebarFocused,
  focusedId,
  multiSelected,
  editingId,
  onCommitRename,
  onCancelRename,
  customIcons,
  iconTheme,
  settings,
  onRevealLink,
  renderRowEnd,
}) {
  const rawNode = outlineNode?.data?.rawNode || {}
  const selectedRenameInputRef = useRef(null)
  const commitCalledRef = useRef(false)
  const doubleClickRenameRef = useRef(false)
  const isEditing = editingId === row.id
  const isFolder = row.kind === 'folder'
  const isSource = !!sourceMeta
  const navigationMode = !!dragState?.navigationMode
  const displayName = rawNode.name || row.id.split('/').pop()
  const iconOverride = customIcons?.[displayName]
  const hasTextIconOverride = typeof iconOverride === 'string'
    && iconOverride !== 'vscode'
    && !iconOverride.startsWith('data:')
  const dwell = dragState?.navigationDwell?.targetId === row.id
    ? dragState.navigationDwell
    : null

  const inputRef = useCallback(input => {
    if (!input) {
      selectedRenameInputRef.current = null
      return
    }
    if (!isEditing || selectedRenameInputRef.current === input) return
    selectedRenameInputRef.current = input
    commitCalledRef.current = false
    input.focus()
    const extensionStart = isFolder ? -1 : input.value.lastIndexOf('.')
    if (extensionStart > 0 && extensionStart < input.value.length - 1) {
      input.setSelectionRange(0, extensionStart)
    } else {
      input.select()
    }
  }, [isEditing, isFolder])

  const commitRename = event => {
    if (commitCalledRef.current) return
    commitCalledRef.current = true
    onCommitRename?.(rawNode, event.currentTarget.value)
  }

  const handleClick = event => {
    if (event.button !== 0) return
    if (event.target.closest('button,input,[data-no-outline-drag]')) return
    event.stopPropagation()
    if (rawNode.isLink && rawNode.linkStale) return
    if (event.detail === 1) {
      doubleClickRenameRef.current = !isFolder
        && !event.metaKey
        && !event.ctrlKey
        && !event.shiftKey
    }
    if (isFolder) {
      onSelect?.({})
      return
    }
    if (event.detail > 1 && doubleClickRenameRef.current) return
    onSelect?.({
      metaKey: event.metaKey || event.ctrlKey,
      shiftKey: event.shiftKey,
    })
  }

  return (
    <div
      {...rowProps}
      className={[
        'arborist-node',
        'outline-dnd-row',
        activeFilePath === row.id ? 'selected' : '',
        activeFilePath === row.id && !sidebarFocused ? 'unfocused' : '',
        focusedId === row.id ? 'tree-focused' : '',
        multiSelected?.has?.(row.id) ? 'multi-selected' : '',
        isSource ? 'drag-source-block' : '',
        sourceMeta?.isFirst ? 'drag-source-first' : '',
        sourceMeta?.isLast ? 'drag-source-last' : '',
        isSource && navigationMode ? 'is-navigation-paused' : '',
        navigationMode && isFolder && row.hasChildren && !navigationProtected ? 'is-navigation-eligible' : '',
        dwell ? 'is-navigation-target' : '',
        dwell?.blocked ? 'is-navigation-protected' : '',
        rawNode.isLink ? 'is-link' : '',
        rawNode.isLink && rawNode.linkStale ? 'link-stale' : '',
      ].filter(Boolean).join(' ')}
      data-node-id={row.id}
      data-parent-id={row.parentId || ''}
      data-depth={row.depth}
      data-is-directory={isFolder ? 'true' : 'false'}
      style={{ ...(rowProps?.style || {}), paddingLeft: `${12 + row.depth * 16}px` }}
      onClick={handleClick}
      onDoubleClick={event => {
        event.preventDefault()
        event.stopPropagation()
        const shouldRename = doubleClickRenameRef.current
        doubleClickRenameRef.current = false
        if (shouldRename && !isEditing && !isSource) onStartRename?.(rawNode)
      }}
      onContextMenu={event => {
        event.preventDefault()
        event.stopPropagation()
        if (event.ctrlKey && !event.metaKey && !event.shiftKey && !isFolder) {
          onSelect?.({ metaKey: true, shiftKey: false })
          return
        }
        onContextMenu?.(event, rawNode)
      }}
    >
      <span className="outline-indent-guides" aria-hidden="true">
        {(connectorMeta?.folderGuideDepths || []).map(depth => (
          <span key={depth} style={{ left: `${18 + depth * ROW_INDENT_PX}px` }} />
        ))}
      </span>

      <span className="outline-file-connectors" aria-hidden="true">
        {(connectorMeta?.fileContinuationDepths || []).map(depth => (
          <span
            key={`continuation-${depth}`}
            className="outline-file-connector is-continuation"
            style={{ left: `${iconAnchorCenter(depth)}px` }}
          />
        ))}
        {connectorMeta?.parentIsFile && (
          <>
            <span
              className="outline-file-connector is-top"
              style={{ left: `${iconAnchorCenter(row.depth - 1)}px` }}
            />
            {connectorMeta.hasNextSibling && (
              <span
                className="outline-file-connector is-bottom"
                style={{ left: `${iconAnchorCenter(row.depth - 1)}px` }}
              />
            )}
            <span
              className="outline-file-connector is-elbow"
              style={{
                left: `${iconAnchorCenter(row.depth - 1)}px`,
                width: `${Math.max(4, iconAnchorStart(row.depth) - iconAnchorCenter(row.depth - 1))}px`,
              }}
            />
          </>
        )}
        {connectorMeta?.hasVisibleFileChildren && (
          <span
            className="outline-file-connector is-parent-stem"
            style={{ left: `${iconAnchorCenter(row.depth)}px` }}
          />
        )}
      </span>

      {isFolder && row.hasChildren ? (
        <button
          type="button"
          className="arborist-chevron outline-disclosure"
          data-no-outline-drag
          data-outline-dnd-ignore
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${rawNode.name || row.id}`}
          aria-expanded={expanded}
          onPointerDown={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation()
            onToggle?.(row.id, !expanded, 'disclosure')
          }}
        >
          {dwell && !dwell.blocked && <FolderProgress progress={dwell.progress} cycle={dwell.cycle} />}
          {dwell?.blocked ? (
            <CircleX className="outline-navigation-stop" size={12} strokeWidth={2} />
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
              <path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z" />
            </svg>
          )}
        </button>
      ) : (
        <span className="arborist-chevron" aria-hidden="true" />
      )}

      <span className="arborist-icon" data-outline-connector-anchor>
        <span className={`outline-icon-anchor-content ${hasTextIconOverride ? 'is-text-icon' : ''}`}>
          <FileIcon
            name={displayName}
            isDirectory={isFolder}
            expanded={expanded}
            customIcons={customIcons}
            theme={iconTheme}
            settings={settings}
          />
        </span>
      </span>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={rawNode.isNew ? (isFolder ? '—' : '—.md') : rawNode.name}
          className="arborist-rename-input"
          data-no-outline-drag
          data-outline-dnd-ignore
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.stopPropagation()
              commitRename(event)
            } else if (event.key === 'Escape') {
              event.stopPropagation()
              onCancelRename?.(rawNode)
            }
          }}
          onBlur={commitRename}
        />
      ) : (
        <span className="arborist-name">
          <span className={`arborist-name-content ${sourceMeta?.isRoot && dragState?.feedback?.direction ? 'has-horizontal-feedback' : ''}`}>
            <span className="arborist-name-text">{displayName}</span>
            {sourceMeta?.isRoot && (
              <HorizontalFeedback feedback={dragState?.feedback} />
            )}
          </span>
        </span>
      )}

      {sourceMeta?.isRoot && navigationMode && (
        <span className="outline-navigation-pause" aria-label="Перемещение приостановлено" title="Перемещение приостановлено">
          <Pause size={10} />
        </span>
      )}

      {rawNode.isLink && (
        <div className="file-row-link-chips" data-no-outline-drag data-outline-dnd-ignore onClick={event => event.stopPropagation()}>
          <button
            className={`file-row-link-chip ${rawNode.linkStale ? 'stale' : ''}`}
            data-no-outline-drag
            data-outline-dnd-ignore
            title={rawNode.linkStale ? 'Оригинал недоступен' : 'Показать оригинал в Finder'}
            onClick={event => {
              event.stopPropagation()
              if (!rawNode.linkStale) onRevealLink?.(row.id)
            }}
          >
            {rawNode.linkStale ? 'link ✕' : 'link'}
          </button>
        </div>
      )}

      {renderRowEnd?.({
        row,
        node: rawNode,
        isFolder,
        customIcons,
        iconTheme,
        settings,
      })}
    </div>
  )
}
