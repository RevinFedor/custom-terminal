import React, { useRef, useState, useEffect, memo } from 'react';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import FileIcon from '../FileIcon';

const FileRow = memo(({ 
  node, 
  level, 
  isExpanded, 
  onToggle, 
  onSelect, 
  isSelected,
  isEditing,
  isOverFolder,
  isInsideOverFolder,
  onCommitRename,
  onCancelRename,
  customIcons,
  iconTheme,
  settings,
  onContextMenu,
  sidebarFocused,
  isFocused,
  isMultiSelected,
  multiSelected
}) => {
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const [closestEdge, setClosestEdge] = useState(null);
  const autoExpandTimerRef = useRef(null);

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

    // Draggable configuration
    const cleanupDraggable = draggable({
      element: el,
      canDrag: () => !isEditing,
      getInitialData: () => ({
        type: 'TREE_NODE',
        fileId: node.id,
        isDirectory: node.isDirectory,
        selectedIds: multiSelected && multiSelected.size > 1 && multiSelected.has(node.id)
          ? [...multiSelected]
          : [node.id]
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });

    // Drop Target configuration
    const cleanupDropTarget = dropTargetForElements({
      element: el,
      canDrop: ({ source }) => {
        // Allow dropping on self so we don't fall through to the Root drop target.
        // The monitor logic will handle the "no-op" (don't highlight self).
        return true; 
      },
      onDragEnter: ({ source, self }) => {
        setIsOver(true);
        const edge = extractClosestEdge(self.data);
        console.log('[dnd]',`[Enter] ${node.name} | isDirectory: ${node.isDirectory} | edge: ${edge || 'center'}`);
        
        // Auto-expand folder logic
        if (node.isDirectory && !isExpanded && source.data.type === 'TREE_NODE') {
            console.log('[dnd]',`[AutoExpand] Timer started for ${node.name}`);
            autoExpandTimerRef.current = setTimeout(() => {
                console.log('[dnd]',`[AutoExpand] Triggering expand for ${node.name}`);
                onToggle(node.id);
            }, 600);
        }
      },
      onDrag: ({ self }) => {
        const edge = extractClosestEdge(self.data);
        if (edge !== closestEdge) {
            setClosestEdge(edge);
        }
      },
      onDragLeave: () => {
        console.log('[dnd]',`[Leave] ${node.name}`);
        setIsOver(false);
        setClosestEdge(null);
        if (autoExpandTimerRef.current) {
            clearTimeout(autoExpandTimerRef.current);
            autoExpandTimerRef.current = null;
        }
      },
      onDrop: ({ self, source }) => {
        const edge = extractClosestEdge(self.data);
        console.log('[dnd]',`[Drop] ON ${node.name} | FROM ${source.data.fileId} | EDGE: ${edge || 'center'}`);
        setIsOver(false);
        setClosestEdge(null);
        if (autoExpandTimerRef.current) {
            clearTimeout(autoExpandTimerRef.current);
            autoExpandTimerRef.current = null;
        }
      },
      // Disable stickiness to ensure precise "dead zone" detection
      // Sticky edges cause the line to persist even when we are in the middle "Drop Into" zone
      getIsSticky: () => false,
      getData: ({ input, element }) => {
        const data = { 
          id: node.id,
          isDirectory: node.isDirectory,
          parentId: node.parentId
        };
        
        // GLOBAL SIMPLIFICATION:
        // We have automatic alphabetical sorting. "Insert between" (lines) makes no sense.
        // We only support "Drop Into Folder" (for directories) or "Drop Into Parent" (for files).
        // Therefore, we NEVER attach edges. We purely rely on the target element identity.
        return data;
      }
    });

    return () => {
      cleanupDraggable();
      cleanupDropTarget();
      if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.isDirectory, node.parentId, isExpanded, onToggle, isOverFolder, multiSelected, isEditing]);

  const handleToggle = (e) => {
    if (e.button !== 0) return; // Only left click
    e.stopPropagation();
    if (node.isDirectory) {
      onToggle(node.id);
    }
  };

  const handleClick = (e) => {
    if (e.button !== 0) return; // Only left click
    e.stopPropagation();
    const modifiers = { metaKey: e.metaKey || e.ctrlKey, shiftKey: e.shiftKey }
    // Don't toggle folder on Cmd+Click or Shift+Click (multi-select mode)
    if (!modifiers.metaKey && !modifiers.shiftKey && node.isDirectory) {
        onToggle(node.id);
    }
    onSelect(modifiers);
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    if (!node.isDirectory) {
        onSelect(node);
    }
  };

  // Styles
  const paddingLeft = level * 16 + 12; 
  
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
      `}
      style={{ paddingLeft: `${paddingLeft}px`, position: 'relative' }}
      onPointerDown={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node); }}
    >
      {/* Edge Indicator Lines */}
      {isDropBefore && <div className="drop-indicator top" />}
      {isDropAfter && <div className="drop-indicator bottom" />}

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

      <span className="arborist-chevron" onPointerDown={handleToggle}>
         {node.isDirectory && (
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
        )}
      </span>
      
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
            {node.name}
          </span>
      )}
    </div>
  );
});

export default FileRow;