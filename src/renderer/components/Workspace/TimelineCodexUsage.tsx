import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Zap } from 'lucide-react';
const formatTokenCount = (count: number) => `${(count / 1000).toFixed(1)}K`;
export function codexTimelineUsageTotal(entry: any): number | null {
  const u = entry.codexUsage;
  return u ? Math.max(0, u.inputUncached) + Math.max(0, u.inputCached)
    + Math.max(0, u.outputAnswer) + Math.max(0, u.outputReasoning) : null;
}
const formatCodexReset = (iso: string | null): string => {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const ms = t - Date.now();
    if (ms <= 0) return 'now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };

// Ordinary Timeline's existing breakdown body, shared by both readers.
export function TimelineCodexUsageBreakdown({ entry, breakdownMode, setBreakdownMode }: {
  entry: any; breakdownMode: 'jsonl' | 'api'; setBreakdownMode: (mode: 'jsonl' | 'api') => void;
}) {
    const u = entry.codexUsage;
    const lim = entry.codexLimits;
    const inputTotal = u ? u.inputUncached + u.inputCached : 0;
    const total = codexTimelineUsageTotal(entry);
    const TabBtn = ({ mode, children }: { mode: 'jsonl' | 'api'; children: React.ReactNode }) => (
      <button
        onClick={(e) => { e.stopPropagation(); setBreakdownMode(mode); }}
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors cursor-pointer"
        style={{
          color: breakdownMode === mode ? '#e8a955' : 'rgba(255,255,255,0.4)',
          backgroundColor: breakdownMode === mode ? 'rgba(232,169,85,0.08)' : 'transparent',
        }}
      >{children}</button>
    );
    const Row = ({ label, value, dim }: { label: string; value: string; dim?: boolean }) => (
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: dim ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.6)' }}>{label}</span>
        <span className="font-mono" style={{ color: dim ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.8)' }}>{value}</span>
      </div>
    );
    const limitRows = lim && (lim.fiveHourPct != null || lim.weeklyPct != null) ? (
      <div className="mt-1.5 pt-1 border-t border-white/10 flex flex-col gap-0.5">
        {lim.fiveHourPct != null && (
          <Row
            label="5-hour limit"
            value={`${Math.round(lim.fiveHourPct)}%${lim.fiveHourResetsAt ? ` · ${formatCodexReset(lim.fiveHourResetsAt)}` : ''}`}
            dim
          />
        )}
        {lim.weeklyPct != null && (
          <Row
            label="Weekly limit"
            value={`${Math.round(lim.weeklyPct)}%${lim.weeklyResetsAt ? ` · ${formatCodexReset(lim.weeklyResetsAt)}` : ''}`}
            dim
          />
        )}
      </div>
    ) : null;

    return (
      <>
        <div className="flex items-center gap-0.5 mb-1.5">
          <TabBtn mode="jsonl">JSONL</TabBtn>
          <TabBtn mode="api">API</TabBtn>
        </div>
        {u ? (
          breakdownMode === 'jsonl' ? (
            <>
              <div className="flex flex-col gap-0.5">
                <Row label="Input" value={formatTokenCount(inputTotal)} />
                {u.inputCached > 0 && <Row label="↳ cached" value={formatTokenCount(u.inputCached)} dim />}
                <Row label="Codex · answer" value={formatTokenCount(u.outputAnswer)} />
                {u.outputReasoning > 0 && <Row label="Codex · reasoning" value={formatTokenCount(u.outputReasoning)} dim />}
              </div>
              <div className="mt-1.5 pt-1 border-t border-white/10 flex items-center justify-between text-[11px]">
                <span className="text-white/50">В JSONL</span>
                <span className="font-mono font-semibold" style={{ color: '#e8a955' }}>{formatTokenCount(total || 0)}</span>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-0.5">
              <Row label="Input billed" value={formatTokenCount(u.inputUncached)} />
              {u.inputCached > 0 && <Row label="↳ cached" value={formatTokenCount(u.inputCached)} dim />}
              <Row label="Input (total)" value={formatTokenCount(inputTotal)} dim />
              <Row label="Output" value={formatTokenCount(u.outputAnswer)} />
              {u.outputReasoning > 0 && <Row label="↳ reasoning" value={formatTokenCount(u.outputReasoning)} dim />}
            </div>
          )
        ) : (
          <div className="text-[11px] text-white/40">No token usage sample</div>
        )}
        {limitRows}
      </>
    );
}
export function TimelineCodexTokenChip({ entry }: { entry: any }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [mode, setMode] = useState<'jsonl' | 'api'>('jsonl');
  const chip = useRef<HTMLSpanElement>(null), popup = useRef<HTMLDivElement>(null);
  const interactive = !!(entry.codexUsage || entry.codexLimits);
  useEffect(() => {
    if (!position) return;
    const move = (event: MouseEvent) => {
      const a = chip.current?.getBoundingClientRect(), b = popup.current?.getBoundingClientRect();
      if (!a || !b) return;
      if (event.clientX >= Math.min(a.left, b.left) - 2 && event.clientX <= Math.max(a.right, b.right) + 2
        && event.clientY >= Math.min(a.top, b.top) - 2 && event.clientY <= Math.max(a.bottom, b.bottom) + 2) return;
      setPosition(null);
    };
    window.addEventListener('mousemove', move); return () => window.removeEventListener('mousemove', move);
  }, [position]);
  return <><span ref={chip} className="flex items-center gap-1 ml-2 text-[10px]"
    onMouseEnter={event => { if (interactive) { const rect = event.currentTarget.getBoundingClientRect();
      setPosition({ top: Math.max(40, Math.min(rect.bottom + 4, window.innerHeight - 210)), left: Math.max(8, rect.left - 180) }); } }}
    style={{ color: '#e8a955', cursor: interactive ? 'help' : 'default',
      textDecoration: interactive ? 'underline dotted rgba(232,169,85,0.4)' : 'none', textUnderlineOffset: '2px' }}>
    <Zap size={10} /><span>{formatTokenCount(codexTimelineUsageTotal(entry) ?? Math.ceil(entry.content.length / 3.5))}</span>
  </span>
  {position && createPortal(<div ref={popup} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    style={{ position: 'fixed', top: position.top, left: position.left, zIndex: 100080,
      backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: '6px 10px',
      minWidth: 180, maxWidth: 260, minHeight: 180, boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
    <TimelineCodexUsageBreakdown entry={entry} breakdownMode={mode} setBreakdownMode={setMode} />
  </div>, document.body)}</>;
}
