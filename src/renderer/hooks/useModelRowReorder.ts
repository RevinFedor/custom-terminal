import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';

type Placement = 'before' | 'after';
type DropTarget = { id: string; placement: Placement };
type DragState = { sourceId: string; orderKey: string };

export function moveModelRow(ids: readonly string[], sourceId: string, targetId: string, placement: Placement): string[] {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return [...ids];
  const remaining = ids.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  remaining.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, sourceId);
  return remaining;
}

export function useModelRowReorder({
  ids,
  provider,
  enabled,
  onReorder,
}: {
  ids: string[];
  provider: 'claude' | 'codex';
  enabled: boolean;
  onReorder: (ids: string[]) => void;
}) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const paintedTargetRef = useRef<DropTarget | null>(null);
  const orderKey = ids.join('\u0000');
  const currentRef = useRef({ ids, orderKey, onReorder });
  currentRef.current = { ids, orderKey, onReorder };

  const clear = () => {
    dragRef.current = null;
    paintedTargetRef.current = null;
    setSourceId(null);
    setTarget(null);
  };

  // A drop may arrive before the next dragover has painted its new side.
  // The insertion line is the promise; commit exactly that last visible slot.
  useEffect(() => { paintedTargetRef.current = target; }, [target]);

  useEffect(() => {
    if (!enabled || (dragRef.current && dragRef.current.orderKey !== orderKey)) clear();
  }, [enabled, orderKey]);
  useEffect(() => {
    const cancelOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clear();
    };
    const cancelOnBlur = () => clear();
    window.addEventListener('keydown', cancelOnEscape, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      window.removeEventListener('keydown', cancelOnEscape, true);
      window.removeEventListener('blur', cancelOnBlur);
      dragRef.current = null;
    };
  }, []);

  const placementAt = (event: DragEvent<HTMLElement>): Placement => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const commit = (source: string, destination: string, placement: Placement) => {
    const next = moveModelRow(currentRef.current.ids, source, destination, placement);
    if (next.some((id, index) => id !== currentRef.current.ids[index])) {
      currentRef.current.onReorder(next);
    }
    clear();
  };

  return {
    sourceId,
    target,
    rowProps: (id: string) => ({
      'data-model-order-row': id,
      'data-model-provider': provider,
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || !enabled || drag.orderKey !== currentRef.current.orderKey || drag.sourceId === id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const placement = placementAt(event);
        setTarget((old) => old?.id === id && old.placement === placement ? old : { id, placement });
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const painted = paintedTargetRef.current;
        if (!drag || !painted || !enabled || drag.orderKey !== currentRef.current.orderKey) return;
        event.preventDefault();
        event.stopPropagation();
        commit(drag.sourceId, painted.id, painted.placement);
      },
    }),
    handleProps: (id: string, label: string) => ({
      draggable: enabled,
      'data-model-drag-handle': id,
      'aria-label': `Переместить модель ${label}`,
      title: 'Перетащить модель или нажать ↑ / ↓',
      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
        if (!enabled || !currentRef.current.ids.includes(id)) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-noted-model-row', `${provider}:${id}`);
        const row = event.currentTarget.closest<HTMLElement>('[data-model-order-row]');
        if (row) {
          const rect = row.getBoundingClientRect();
          event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top);
        }
        dragRef.current = { sourceId: id, orderKey: currentRef.current.orderKey };
        setSourceId(id);
        setTarget(null);
      },
      onDragEnd: clear,
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        const order = currentRef.current.ids;
        const index = order.indexOf(id);
        const neighbour = order[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (!neighbour) return;
        commit(id, neighbour, event.key === 'ArrowUp' ? 'before' : 'after');
      },
    }),
  };
}
