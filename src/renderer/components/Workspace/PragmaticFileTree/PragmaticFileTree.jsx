import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { flattenTree } from './utils';
import FileRow from './FileRow';
import ScrollHints from './ScrollHints';

const PragmaticFileTree = ({ 
  treeData, // Raw recursive tree data
  folderPath, // Root path
  onFileSelect,
  activeFilePath,
  customIcons,
  iconTheme,
  settings,
  onContextMenu,
  onRename, // Callback to notify parent of moves if needed
  onToggle, // Prop from parent to load children (legacy/data loading)
  onExpandChange, // Sync expanded state with parent
  initialExpanded = {},
  editingId,
  onCommitRename,
  onCancelRename,
  sidebarFocused,
  focusedId,
  multiSelected = new Set()
}) => {
  const [expandedIds, setExpandedIds] = useState(initialExpanded);
  const containerRef = useRef(null);
  const [isRootOver, setIsRootOver] = useState(false);
  const [overFolderId, setOverFolderId] = useState(null);
  const [isDraggingGlobal, setIsDraggingGlobal] = useState(false);

  // Update expandedIds if initialExpanded changes (e.g. on full refresh)
  useEffect(() => {
      if (initialExpanded && Object.keys(initialExpanded).length > 0) {
          setExpandedIds(prev => ({ ...prev, ...initialExpanded }));
      }
  }, [initialExpanded]);

  // Scroll active file into view после reveal
  useEffect(() => {
    if (!activeFilePath) return
    setTimeout(() => {
      const container = containerRef.current
      if (!container) return
      const activeRow = container.querySelector('.file-row.selected')
      if (activeRow) {
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }, 0)
  }, [activeFilePath]);

  // Toggle Folder
  const handleToggle = (id) => {
    setExpandedIds(prev => {
      const newState = {
        ...prev,
        [id]: !prev[id]
      };
      if (onExpandChange) onExpandChange(newState);
      return newState;
    });
    if (onToggle) onToggle(id);
  };

  // Flatten the tree for rendering
  const visibleNodes = useMemo(() => {
    return flattenTree(treeData, expandedIds);
  }, [treeData, expandedIds]);

  // Enable Auto-Scroll
  useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      return autoScrollForElements({
          element: el,
      });
  }, []);

  // Drop Monitor
  useEffect(() => {
    return monitorForElements({
      onDragStart: (args) => {
        // Только для drag из sidebar (TREE_NODE), не для табов
        if (args.source.data.type !== 'TREE_NODE') return;
        console.log('[dnd]',`[Monitor] Drag started: ${args.source.data.fileId}`);
        setIsDraggingGlobal(true);
      },
      onDrag: ({ location, source }) => {
        const target = location.current.dropTargets[0];
        if (!target) {
            setOverFolderId(null);
            setIsRootOver(false);
            return;
        }

        // If specifically dropped on the root container (empty space)
        if (target.data.isRoot) {
            setOverFolderId(null);
            setIsRootOver(true);
            return;
        }

        // If hovering over any file/folder, Root Drop is FALSE
        setIsRootOver(false);

        const edge = extractClosestEdge(target.data);
        
        // If we are targeting an edge (inserting), we don't highlight the folder content
        if (edge) {
            setOverFolderId(null);
            return;
        }

        let targetFolderId = null;

        // If hovering center of a directory -> highlight it
        if (target.data.isDirectory) {
            targetFolderId = target.data.id;
        } 
        // If hovering center of a file -> highlight its parent
        else if (target.data.parentId) {
            targetFolderId = target.data.parentId;
        }

        // VS Code Parity: Don't highlight the folder if the file is already inside it
        const sourcePath = source.data.fileId;
        const sourceParent = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
        
        if (targetFolderId === sourceParent) {
            setOverFolderId(null);
        } else {
            setOverFolderId(targetFolderId);
        }
      },
      onDragLeave: () => {
        setOverFolderId(null);
        setIsRootOver(false);
      },
      onDrop: async ({ source, location }) => {
        // Только для drag из sidebar
        if (source.data.type !== 'TREE_NODE') return;

        setIsDraggingGlobal(false);
        setOverFolderId(null);
        setIsRootOver(false);
        const target = location.current.dropTargets[0];

        if (!target) {
            console.log('[dnd]','[Monitor] Drop cancelled (no target)');
            return;
        }

        const sourceId = source.data.fileId;
        const targetData = target.data;
        
        if (!sourceId) return; // Not a file drag?

        let destinationFolder = null;
        const closestEdge = extractClosestEdge(targetData);

        console.log('[dnd]',`[Monitor] Dropped: ${sourceId} on ${targetData.id || (targetData.isRoot ? 'ROOT' : 'unknown')} (edge: ${closestEdge || 'center'})`);

        // 1. Determine Destination
        if (targetData.isRoot) {
           destinationFolder = folderPath;
        } else if (targetData.isDirectory) {
           // Dropped INTO a folder (center zone)
           destinationFolder = targetData.id;
           console.log('[dnd]',`[Monitor] Decision: Move INTO folder -> ${destinationFolder}`);
        } else {
           // Dropped on a file — ignore (only folders accept drops)
           console.log('[dnd]',`[Monitor] Decision: Drop on file ignored`);
           return;
        }

        // 2. Execute Move (multi-select: move all selected items)
        if (destinationFolder) {
            const allSourceIds = source.data.selectedIds && source.data.selectedIds.length > 1
              ? source.data.selectedIds
              : [sourceId]

            for (const sid of allSourceIds) {
              if (!sid) continue
              const sParent = sid.substring(0, sid.lastIndexOf('/'));
              if (sParent === destinationFolder) {
                  console.log('[dnd]',`[Monitor] ${sid} already in target folder, skipping`);
                  continue;
              }
              const fName = sid.split('/').pop();
              const nPath = `${destinationFolder}/${fName}`;
              console.log('[dnd]',`[Monitor] Executing moveItem: ${sid} -> ${destinationFolder}`);
              const success = await window.electronAPI.moveItem(sid, destinationFolder);
              if (success) {
                  console.log('[dnd]',`[Monitor] Move success: ${nPath}`);
                  if (onRename) onRename(sid, nPath);
              } else {
                  console.log('[dnd]',`[Monitor] ERROR: Move failed for ${sid}`);
              }
            }
        }
      }
    });
  }, [folderPath, onRename]);

  // Root Drop Target (The empty area)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    return dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data.type === 'TREE_NODE',
        getData: () => ({ isRoot: true }),
    });
  }, []);

  return (
    <div 
        ref={containerRef} 
        className={`arborist-tree file-tree-container ${isRootOver ? 'root-drop-active' : ''} ${isDraggingGlobal ? 'is-dragging-global' : ''}`}
        style={{ minHeight: '100%', paddingBottom: '100px', position: 'relative' }} // Increased padding
        onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
                onContextMenu(e, null); // Context menu on empty area
            }
        }}
    >
      <ScrollHints containerRef={containerRef} active={isDraggingGlobal} />

      {/* Visual indicator for Root Drop */}
      {isRootOver && (
        <div className="root-drop-indicator">
            <span>Drop to move to root</span>
        </div>
      )}

      {visibleNodes.map((node) => (
        <FileRow
          key={node.id}
          node={node}
          level={node.level}
          isExpanded={expandedIds[node.id]}
          isSelected={activeFilePath === node.id}
          isEditing={editingId === node.id}
          isOverFolder={overFolderId === node.id}
          isInsideOverFolder={overFolderId && node.id.startsWith(overFolderId + '/')}
          onToggle={handleToggle}
          onSelect={(modifiers) => onFileSelect(node.id, node.isDirectory, modifiers)}
          onCommitRename={onCommitRename}
          onCancelRename={onCancelRename}
          customIcons={customIcons}
          iconTheme={iconTheme}
          settings={settings}
          onContextMenu={onContextMenu}
          sidebarFocused={sidebarFocused}
          isFocused={focusedId === node.id}
          isMultiSelected={multiSelected.has(node.id)}
          multiSelected={multiSelected}
        />
      ))}
    </div>
  );
};

export default PragmaticFileTree;
