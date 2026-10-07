import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HardDrive } from 'lucide-react';
import { useDiskCapacity } from '../../store/useDiskCapacity';
import { diskCapacityBytes, diskCapacityPresentation } from '../../utils/diskCapacityPresentation.mjs';

// A click disclosure, never an automatic popup. Only known low headroom is
// amber; an unavailable/expired measurement remains visibly distinct from safe.
export default function DiskCapacityWarning() {
  const panelId = useId();
  const snapshot = useDiskCapacity();
  const status = diskCapacityPresentation(snapshot);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 40, right: 8, maxHeight: 400 });
  const visible = status !== 'healthy';
  const title = status === 'warning' ? 'Мало места на диске'
    : status === 'stale' ? 'Замер диска устарел'
      : status === 'error' ? 'Нет данных о диске' : 'Проверка свободного места';
  const color = status === 'warning' ? '#fbbf24' : status === 'error' ? '#f87171' : '#a1a1aa';

  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  useLayoutEffect(() => {
    if (!open || !visible) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 80));
      const width = Math.min(320, window.innerWidth - 16);
      setPosition({ top, right: Math.min(Math.max(8, window.innerWidth - rect.right),
        Math.max(8, window.innerWidth - width - 8)),
        maxHeight: Math.max(64, window.innerHeight - top - 8) });
    };
    update();
    const observer = new ResizeObserver(update);
    if (trigger.current?.parentElement) observer.observe(trigger.current.parentElement);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [open, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    const outside = (event: MouseEvent) => {
      if (trigger.current?.contains(event.target as Node) || panel.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      setOpen(false); trigger.current?.focus({ preventScroll: true });
    };
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape, true); };
  }, [open, visible]);

  if (!visible) return null;
  const warning = status === 'warning';
  const hasMeasurement = snapshot?.measuredAt != null && (warning || status === 'stale');
  const rows = [
    { label: 'Кэш / лимит', first: hasMeasurement ? snapshot.cacheBytes : null, second: snapshot?.budgetBytes, firstKey: 'used', secondKey: 'limit' },
    { label: 'Свободно / рост кэша', first: hasMeasurement ? snapshot.freeBytes : null, second: hasMeasurement ? snapshot.remainingGrowthBytes : null, firstKey: 'free', secondKey: 'remaining' },
    { label: 'После роста / минимум', first: hasMeasurement ? snapshot.projectedFreeBytes : null, second: snapshot?.reserveBytes, firstKey: 'projected', secondKey: 'reserve' },
  ];
  return <>
    <button type="button" ref={trigger} onClick={() => setOpen(value => !value)}
      aria-label={title} aria-expanded={open} aria-controls={open ? panelId : undefined}
      title={title} data-disk-capacity={status}
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md cursor-pointer"
      style={{ color,
        border: `1px solid ${warning ? 'rgba(251,191,36,0.4)' : status === 'error' ? 'rgba(248,113,113,0.4)' : 'rgba(255,255,255,0.16)'}`,
        background: warning ? 'rgba(251,191,36,0.1)' : status === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.04)',
        WebkitAppRegion: 'no-drag', flexShrink: 0 } as React.CSSProperties}>
      <HardDrive size={13} />
    </button>
    {open && createPortal(<div ref={panel} id={panelId} role="dialog" aria-modal="false"
      aria-label="Свободное место для кэша History" data-disk-capacity-panel={status}
      style={{ position: 'fixed', top: position.top, right: position.right,
        width: 'min(320px, calc(100vw - 16px))', maxHeight: position.maxHeight, overflowY: 'auto',
        zIndex: 10000, background: '#1a1a1a', border: '1px solid #444', borderRadius: 8,
        padding: 10, boxShadow: '0 8px 24px #0008', fontSize: 11, color: '#d4d4d8',
        WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {status !== 'warning' && <div style={{ color, marginBottom: 8 }}>
        {status === 'stale' ? 'Замер устарел' : status === 'error' ? 'Нет данных' : 'Проверка…'}
      </div>}
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '6px 10px', margin: 0 }}>
        {rows.map(row => <React.Fragment key={row.firstKey}>
          <dt>{row.label}</dt><dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            <span data-disk-value={row.firstKey}>{diskCapacityBytes(row.first).replace(/ ГиБ$/, '')}</span>
            <span style={{ color: '#777' }}> / </span>
            <span data-disk-value={row.secondKey}>{diskCapacityBytes(row.second).replace(/ ГиБ$/, '')}</span>
            {(Number.isFinite(row.first) || Number.isFinite(row.second)) && <span style={{ color: '#999' }}> ГиБ</span>}
          </dd>
        </React.Fragment>)}
      </dl>
    </div>, document.body)}
  </>;
}
