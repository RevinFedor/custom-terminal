import React, { useRef, useState, useEffect, memo } from 'react';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { disableNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview';
import { preventUnhandled } from '@atlaskit/pragmatic-drag-and-drop/prevent-unhandled';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import FileIcon from './FileIcon';

const VISUAL_PARENT_STEP_PX = 28;
const VISUAL_ICON_CENTER_OFFSET_PX = 26;
const VISUAL_ICON_HALF_PX = 8;
const VISUAL_CONNECTOR_ICON_GAP_PX = 4;
const VISUAL_ELBOW_END_OFFSET_PX = VISUAL_ICON_CENTER_OFFSET_PX - VISUAL_ICON_HALF_PX - VISUAL_CONNECTOR_ICON_GAP_PX;
const NESTED_CONTROL_SELECTOR = '[data-no-card-drag],button,input,textarea,select,a';
let treeDragTokenSequence = 0;

const nextTreeDragToken = () => `${Date.now().toString(36)}-${(treeDragTokenSequence += 1).toString(36)}`;

const isNestedRowControl = (target) => !!target?.closest?.(NESTED_CONTROL_SELECTOR);

const FileRow = memo(({
  node,
  level,
  isExpanded,
  onToggle,
  onSelect,
  isSelected,
  isEditing,
  isOverFolder,
  springOpenState,
  isInsideOverFolder,
  onCommitRename,
  onCancelRename,
  onStartRename,
  customIcons,
  iconTheme,
  settings,
  onContextMenu,
  sidebarFocused,
  isFocused,
  isMultiSelected,
  multiSelected,
  isIndexed,
  indexPresets,
  onChangeIndexPresets,
  indexSortMode,
  onRevealLink,
  onRemoveLink,
  rawNode,
  fileProjects,
  hasNextVisualSibling = false,
  visualContinuationDepths = [],
  visualParentLevel = null,
  horizontalIntent = null,
  verticalBlockHint = null,
  dragSourceMeta = null,
  verticalLimitHint = null,
  isGlobalDragging = false,
  suppressDropTargets = false,
  isDropConfirmed = false,
  IndexButtonComponent = null,
  onOpenProjectFile
}) => {
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const [closestEdge, setClosestEdge] = useState(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
        inputRef.current.focus();
        const val = inputRef.current.value;
        const dotIndex = val.lastIndexOf('.');
        // Select only the name part (before extension) so user can type and .md stays
        if (dotIndex > 0) {
            inputRef.current.setSelectionRange(0, dotIndex);
        } else {
            inputRef.current.select();
        }
    }
  }, [isEditing]);

  const commitCalledRef = useRef(false);

  useEffect(() => {
    if (isEditing) commitCalledRef.current = false;
  }, [isEditing]);

  useEffect(() => {
    setIsOver(false);
    setClosestEdge(null);
    if (!isGlobalDragging) setIsDragging(false);
  }, [isGlobalDragging, suppressDropTargets]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
        e.stopPropagation(); // Prevent Enter from bubbling to document Enter-to-rename listener
        console.log('[FileRow] Enter pressed, node:', node.id, 'value:', e.target.value, 'commitCalled:', commitCalledRef.current);
        if (!commitCalledRef.current) {
          commitCalledRef.current = true;
          onCommitRename(node, e.target.value);
        }
    } else if (e.key === 'Escape') {
        e.stopPropagation();
        onCancelRename(node);
    }
  };

  const handleBlur = (e) => {
      console.log('[FileRow] Blur fired, node:', node.id, 'value:', e.target.value, 'commitCalled:', commitCalledRef.current);
      if (!commitCalledRef.current) {
        commitCalledRef.current = true;
        onCommitRename(node, e.target.value);
      }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Link rows are virtual, but they can still participate in logical sidebar
    // ordering / visual parent DnD. Physical filesystem moves are skipped by the
    // tree monitor.
    const cleanupDraggable = draggable({
      element: el,
      canDrag: ({ input }) => {
        if (isEditing) return false;
        // Pragmatic exposes the initial pointer coordinates, but not the DOM target.
        const inputTarget = document.elementFromPoint(input.clientX, input.clientY);
        return !isNestedRowControl(inputTarget);
      },
      getInitialData: () => ({
        type: 'TREE_NODE',
        dragToken: nextTreeDragToken(),
        fileId: node.id,
        isDirectory: node.isDirectory,
        isLink: !!node.isLink,
        selectedIds: multiSelected && multiSelected.size > 1 && multiSelected.has(node.id)
          ? [...multiSelected]
          : [node.id]
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        disableNativeDragPreview({ nativeSetDragImage });
        preventUnhandled.start();
        console.log(
          '[SidebarDnd]',
          `native-preview disabled source=${node.id.split('/').slice(-2).join('/')}` +
          ` hasSetDragImage=${nativeSetDragImage ? 1 : 0} preventUnhandled=1` +
          ` wall=${Date.now()}`
        );
      },
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });

    // Drop Target configuration
    const cleanupDropTarget = dropTargetForElements({
      element: el,
      canDrop: ({ source }) => {
        // Allow dropping on self so we don't fall through to the Root drop target.
        // The monitor logic will handle the "no-op" (don't highlight self).
        return source.data.type === 'TREE_NODE';
      },
      onDragEnter: ({ source, self }) => {
        if (source.data.type === 'TREE_NODE' && (isGlobalDragging || suppressDropTargets)) return;
        setIsOver(true);
        const edge = extractClosestEdge(self.data);
        console.log('[dnd]',`[Enter] ${node.name} | isDirectory: ${node.isDirectory} | edge: ${edge || 'center'}`);
        
      },
      onDrag: ({ source, self }) => {
        if (source.data.type === 'TREE_NODE' && (isGlobalDragging || suppressDropTargets)) return;
        const edge = extractClosestEdge(self.data);
        if (edge !== closestEdge) {
            setClosestEdge(edge);
        }
      },
      onDragLeave: () => {
        if (isGlobalDragging || suppressDropTargets) {
          setIsOver(false);
          setClosestEdge(null);
          return;
        }
        console.log('[dnd]',`[Leave] ${node.name}`);
        setIsOver(false);
        setClosestEdge(null);
      },
      onDrop: ({ self, source }) => {
        if (source.data.type === 'TREE_NODE' && (isGlobalDragging || suppressDropTargets)) {
          setIsOver(false);
          setClosestEdge(null);
          return;
        }
        const edge = extractClosestEdge(self.data);
        console.log('[dnd]',`[Drop] ON ${node.name} | FROM ${source.data.fileId} | EDGE: ${edge || 'center'}`);
        setIsOver(false);
        setClosestEdge(null);
      },
      // Disable stickiness to ensure precise "dead zone" detection
      // Sticky edges cause the line to persist even when we are in the middle "Drop Into" zone
      getIsSticky: () => false,
      getData: ({ input, element }) => {
        const data = { 
          id: node.id,
          isDirectory: node.isDirectory,
          parentId: node.parentId,
          isLink: !!node.isLink,
        };

        const rect = element.getBoundingClientRect();
        const y = input.clientY - rect.top;
        if (y <= 5 || rect.height - y <= 5) {
          return attachClosestEdge(data, {
            element,
            input,
            allowedEdges: ['top', 'bottom'],
          });
        }
        return data;
      }
    });

    return () => {
      cleanupDraggable();
      cleanupDropTarget();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.isDirectory, node.parentId, node.isLink, isExpanded, onToggle, isOverFolder, multiSelected, isEditing, isGlobalDragging, suppressDropTargets]);

  const handleToggle = (e) => {
    if (e.button !== 0) return; // Only left click
    e.stopPropagation();
    if (node.isDirectory) {
      onToggle(node.id);
    }
  };

  const handleClick = (e) => {
    if (e.button !== 0) return; // Only left click
    if (isNestedRowControl(e.target)) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    // Stale link → original is gone. Don't try to open it (would 404); the
    // user removes & re-adds. Row stays selectable for the RMB Delete though.
    if (node.isLink && node.linkStale) return;
    const modifiers = { metaKey: e.metaKey || e.ctrlKey, shiftKey: e.shiftKey }
    // Folders never enter multi-selection. Modifier+click on folder behaves as plain click (toggle).
    if (node.isDirectory) {
        onToggle(node.id);
        onSelect({});
        return;
    }
    onSelect(modifiers);
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    if (isNestedRowControl(e.target)) return;
    // Finder-style: double-click on a row → start rename (works for files AND folders).
    if (onStartRename) onStartRename(node);
  };

  // Styles
  const visualDepth = Math.max(0, node.visualDepth || 0);
  const baseIndent = level * 16 + 12;
  const visualBaseLevel = Number.isFinite(visualParentLevel) ? visualParentLevel : level;
  const visualBaseIndent = visualBaseLevel * 16 + 12;
  const visualIndent = visualDepth * VISUAL_PARENT_STEP_PX;
  const paddingLeft = baseIndent + visualIndent;
  const visualConnectorLeft = visualDepth > 0
    ? visualBaseIndent + ((visualDepth - 1) * VISUAL_PARENT_STEP_PX) + VISUAL_ICON_CENTER_OFFSET_PX
    : 0;
  const visualConnectorElbowWidth = visualDepth > 0
    ? Math.max(10, paddingLeft + VISUAL_ELBOW_END_OFFSET_PX - visualConnectorLeft)
    : 0;
  const visualConnectorLeftForDepth = (depth) => (
    visualBaseIndent + ((depth - 1) * VISUAL_PARENT_STEP_PX) + VISUAL_ICON_CENTER_OFFSET_PX
  );
  const intentProgress = Math.max(0, Math.min(1, horizontalIntent?.progress || 0));
  const intentDirection = intentProgress > 0 ? horizontalIntent?.direction : '';
  const intentDisabled = !!horizontalIntent?.disabled;
  const showLeftIntent = intentDirection === 'left';
  const showRightIntent = intentDirection === 'right';
  const isVerticalBlockHint = !!verticalBlockHint;
  const verticalLimitDirection = verticalLimitHint?.direction === 'up' || verticalLimitHint?.direction === 'down'
    ? verticalLimitHint.direction
    : '';
  const isVerticalLimitHint = !!verticalLimitDirection;
  const intentLeft = intentDirection === 'left'
    ? Math.max(4, paddingLeft - 36)
    : paddingLeft + 14;
  const intentOpacity = intentProgress ? (0.18 + intentProgress * 0.72).toFixed(2) : 0;
  const intentBgAlpha = intentProgress ? (0.08 + intentProgress * 0.2).toFixed(2) : 0;
  const intentBorderAlpha = intentProgress ? (0.2 + intentProgress * 0.5).toFixed(2) : 0;
  
  // A row is a "Drop Into" target if it's a folder and we are in its middle,
  // OR if the parent decided this is the active drop folder.
  const isDropInto = isOverFolder || (!closestEdge && isOver && node.isDirectory);
  
  // Lines should ONLY show if we are NOT in a drop-into state and NOT inside a target folder area.
  // This prevents the "line inside highlighted block" glitch.
  const shouldShowLines = !isDropInto && !isInsideOverFolder; 
  
  const isDropBefore = shouldShowLines && isOver && closestEdge === 'top';
  const isDropAfter = shouldShowLines && isOver && closestEdge === 'bottom';

  return (
    <div
      ref={ref}
      className={`
        arborist-node
        ${isSelected ? 'selected' : ''}
        ${isSelected && !sidebarFocused ? 'unfocused' : ''}
        ${isFocused ? 'tree-focused' : ''}
        ${isMultiSelected ? 'multi-selected' : ''}
        ${isDropInto ? 'drop-target' : ''}
        ${isInsideOverFolder ? 'inside-drop-target' : ''}
        ${isDragging ? 'is-dragging' : ''}
        ${isDropBefore ? 'drop-before' : ''}
        ${isDropAfter ? 'drop-after' : ''}
        ${isDropConfirmed ? 'drop-confirmed' : ''}
        ${isVerticalBlockHint ? 'vertical-block-hint' : ''}
        ${verticalBlockHint?.isFirst ? 'vertical-block-hint-first' : ''}
        ${verticalBlockHint?.isLast ? 'vertical-block-hint-last' : ''}
        ${dragSourceMeta ? 'drag-source-block' : ''}
        ${dragSourceMeta ? (dragSourceMeta.isRoot ? 'drag-source-root' : 'drag-source-descendant') : ''}
        ${dragSourceMeta?.isFirst ? 'drag-source-first' : ''}
        ${dragSourceMeta?.isLast ? 'drag-source-last' : ''}
        ${isVerticalLimitHint ? 'vertical-limit-hint' : ''}
        ${verticalLimitDirection ? `vertical-limit-${verticalLimitDirection}` : ''}
        ${node.isLink ? 'is-link' : ''}
        ${node.isLink && node.linkStale ? 'link-stale' : ''}
        ${visualDepth ? 'visual-child' : ''}
      `}
      data-node-id={node.id}
      data-is-directory={node.isDirectory ? 'true' : 'false'}
      data-parent-id={node.parentId || ''}
      data-visual-parent-id={node.visualParentId || ''}
      data-visual-depth={visualDepth || undefined}
      data-horizontal-intent-direction={intentDirection || undefined}
      data-horizontal-intent-progress={intentProgress ? intentProgress.toFixed(2) : undefined}
      data-horizontal-intent-disabled={intentDisabled ? 'true' : undefined}
      data-vertical-block-hint={isVerticalBlockHint ? 'true' : undefined}
      data-vertical-block-hint-root={verticalBlockHint?.rootId || undefined}
      data-drag-source={dragSourceMeta ? (dragSourceMeta.isRoot ? 'root' : 'descendant') : undefined}
      data-vertical-limit-direction={verticalLimitDirection || undefined}
      data-vertical-limit-target={verticalLimitHint?.targetId || undefined}
      style={{
        paddingLeft: `${paddingLeft}px`,
        position: 'relative',
        '--file-row-visual-connector-left': `${visualConnectorLeft}px`,
        '--file-row-visual-connector-width': `${visualConnectorElbowWidth}px`,
        '--file-row-horizontal-intent-progress': intentProgress,
        '--file-row-horizontal-intent-left': `${intentLeft}px`,
        '--file-row-horizontal-intent-opacity': intentOpacity,
        '--file-row-horizontal-intent-bg-alpha': intentBgAlpha,
        '--file-row-horizontal-intent-border-alpha': intentBorderAlpha,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // macOS: Ctrl+Click fires contextmenu instead of click. Treat it as Cmd+Click
        // multi-select toggle — but only for files. Folders never enter multi-selection.
        if (e.ctrlKey && !e.metaKey && !e.shiftKey && !node.isDirectory) {
          onSelect({ metaKey: true, shiftKey: false });
          return;
        }
        onContextMenu(e, node);
      }}
    >
      {/* Edge Indicator Lines */}
      {isDropBefore && <div className="drop-indicator top" />}
      {isDropAfter && <div className="drop-indicator bottom" />}

      {isVerticalLimitHint && (
        <span
          className={`file-row-vertical-limit-marker is-${verticalLimitDirection}`}
          aria-hidden="true"
        />
      )}

      {showLeftIntent && (
        <span
          className={`file-row-horizontal-intent is-left ${intentDisabled ? 'is-disabled' : ''}`}
          aria-hidden="true"
        />
      )}

      {visualContinuationDepths.map(depth => (
        <span
          key={`visual-continuation-${depth}`}
          className="file-row-visual-connector file-row-visual-connector-continuation"
          style={{ left: `${visualConnectorLeftForDepth(depth)}px` }}
          data-visual-continuation-depth={depth}
          aria-hidden="true"
        />
      ))}

      {visualDepth > 0 && (
        <>
          <span
            className="file-row-visual-connector file-row-visual-connector-top"
            aria-hidden="true"
          />
          {hasNextVisualSibling && (
            <span
              className="file-row-visual-connector file-row-visual-connector-bottom"
              aria-hidden="true"
            />
          )}
          <span
            className="file-row-visual-connector-elbow"
            aria-hidden="true"
          />
        </>
      )}

      {/* Indent guides — вертикальные линии */}
      {level > 0 && Array.from({ length: level }).map((_, i) => (
        <span
          key={i}
          className="arborist-indent-guide"
          style={{ 
            left: `${i * 16 + 12}px`,
            opacity: isInsideOverFolder ? 0.6 : undefined // Highlight guide if parent is target
          }}
        />
      ))}

      {node.isDirectory ? (
        <button
          type="button"
          className="arborist-chevron"
          data-no-card-drag
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name}`}
          aria-expanded={isExpanded}
          onClick={handleToggle}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <svg 
            width="12" 
            height="12" 
            viewBox="0 0 16 16" 
            fill="currentColor" 
            style={{ 
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', 
              transition: 'transform 0.15s'
            }}
          >
            <path d="M6 12.796V3.204L11.481 8 6 12.796zm.659.753 5.48-4.796a1 1 0 0 0 0-1.506L6.66 2.451C6.011 1.885 5 2.345 5 3.204v9.592a1 1 0 0 0 1.659.753z"/>
          </svg>
        </button>
      ) : (
        <span className="arborist-chevron" aria-hidden="true" />
      )}
      
      <span className="arborist-icon">
        <FileIcon
          name={node.name}
          isDirectory={node.isDirectory}
          expanded={isExpanded}
          customIcons={customIcons}
          theme={iconTheme}
          settings={settings}
        />
      </span>
      {node.isDirectory && (
        <span
          className={`file-row-spring-open is-${springOpenState?.phase || 'idle'}`}
          data-spring-open-phase={springOpenState?.phase || undefined}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" focusable="false">
            <circle className="file-row-spring-open-track" cx="8" cy="8" r="5.5" />
            <circle className="file-row-spring-open-progress" cx="8" cy="8" r="5.5" />
          </svg>
        </span>
      )}
      
      {isEditing ? (
          <input
              ref={inputRef}
              type="text"
              defaultValue={node.isNew ? (node.isDirectory ? '—' : '—.md') : node.name}
              className="arborist-rename-input"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
          />
      ) : (
          <span className="arborist-name">
            <span className="arborist-name-text">{node.name}</span>
            {showRightIntent && (
              <span
                className={`file-row-horizontal-intent-inline is-right ${intentDisabled ? 'is-disabled' : ''}`}
                aria-hidden="true"
              />
            )}
          </span>
      )}

      {isIndexed && rawNode && IndexButtonComponent && (
        <IndexButtonComponent
          folderNode={rawNode}
          presets={indexPresets || []}
          onChangePresets={(next) => onChangeIndexPresets && onChangeIndexPresets(node.id, next)}
          sortMode={indexSortMode}
          customIcons={customIcons}
          iconTheme={iconTheme}
          settings={settings}
        />
      )}

      {node.isLink && (
        <div className="file-row-link-chips" onClick={(e) => e.stopPropagation()}>
          <button
            className={`file-row-link-chip ${node.linkStale ? 'stale' : ''}`}
            title={node.linkStale
              ? `Оригинал недоступен — файл перемещён или удалён:\n${node.id}\nУдалите линк и добавьте заново.`
              : `Линк на:\n${node.id.substring(0, node.id.lastIndexOf('/'))}\nКлик — показать в Finder`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              if (node.linkStale) return
              onRevealLink && onRevealLink(node.id)
            }}
          >
            {node.linkStale ? 'link ✕' : 'link'}
          </button>
        </div>
      )}

      {Array.isArray(fileProjects) && fileProjects.length > 0 && (
        <div className="file-row-project-chips" onClick={(e) => e.stopPropagation()}>
          {fileProjects.map(p => (
            <button
              key={p.id}
              className="file-row-project-chip"
              title={`Открыть в проекте «${p.name}»`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async (e) => {
                e.stopPropagation()
                try {
                  // openProjectWindow = focus-or-create. Затем route файл в это окно
                  // — main решит куда (project window получит open-file и откроет таб).
                  await onOpenProjectFile?.(p, node.id)
                } catch (err) {
                  console.error('[FileRow] open in project failed:', err)
                }
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default FileRow;
