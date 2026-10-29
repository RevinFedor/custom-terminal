import React, { useCallback, useLayoutEffect, useRef } from 'react';
import type { HistoryAgentCatalogCounts } from '../../../shared/history-agent-catalog-client.mjs';
export type { HistoryAgentCatalogCounts } from '../../../shared/history-agent-catalog-client.mjs';

const ROW_HEIGHT = 28;
const HEADING_HEIGHT = 22;
const PAGE_SIZE = 64;
const OVERSCAN = 8;

// These coordinates belong only to the agent roster's single-line rows. They
// are not History physical keys, measured-layout baselines or restore proof.
export function historyAgentCatalogSections(counts: HistoryAgentCatalogCounts) {
  let offset = 0, headingCount = 0;
  return (['running', 'completed', 'interrupted'] as const).flatMap(section => {
    const count = counts[section];
    if (!count) return [];
    const result = { section, count, offset, top: offset * ROW_HEIGHT + headingCount * HEADING_HEIGHT,
      rowsTop: offset * ROW_HEIGHT + (headingCount + 1) * HEADING_HEIGHT };
    offset += count; headingCount++;
    return [result];
  });
}

export function historyAgentCatalogViewportDemand(counts: HistoryAgentCatalogCounts, top: number, height: number) {
  const sections = historyAgentCatalogSections(counts);
  const rankAt = (position: number) => {
    for (const section of sections) {
      if (position < section.rowsTop + section.count * ROW_HEIGHT) {
        return section.offset + Math.max(0, Math.floor((position - section.rowsTop) / ROW_HEIGHT));
      }
    }
    return Math.max(0, counts.roster - 1);
  };
  const first = rankAt(Math.max(0, top));
  const last = Math.min(counts.roster, rankAt(Math.max(0, top) + Math.max(ROW_HEIGHT, height)) + 1);
  return { first, last, offset: Math.max(0, Math.min(Math.max(0, counts.roster - PAGE_SIZE), first - OVERSCAN)), limit: PAGE_SIZE };
}

/** One ordinary scroll surface, with exact full height and a bounded page.
 * Every completed/interrupted row remains reachable; no last-K cache grows
 * as the user scrolls. Pending pages never become an empty catalog fact. */
export function HistoryAgentCatalogWindow<T>({
  counts, rows, pageStart, status, error, onRequestPage, renderRow,
}: {
  counts: HistoryAgentCatalogCounts | null;
  rows: readonly T[];
  pageStart: number;
  status: 'pending' | 'ready' | 'error';
  error?: string | null;
  onRequestPage: (request: { section: 'roster'; offset: number; limit: number }) => void;
  renderRow: (row: T, rank: number) => React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const requested = useRef<{ counts: HistoryAgentCatalogCounts; offset: number } | null>(null);
  const requestVisible = useCallback(() => {
    const element = scroller.current;
    if (!counts || !element || counts.roster === 0) return;
    const demand = historyAgentCatalogViewportDemand(counts, element.scrollTop, element.clientHeight);
    if (pageStart <= demand.first && pageStart + rows.length >= demand.last) return;
    if (requested.current?.counts === counts && requested.current.offset === demand.offset) return;
    requested.current = { counts, offset: demand.offset };
    onRequestPage({ section: 'roster', offset: demand.offset, limit: demand.limit });
  }, [counts, onRequestPage, pageStart, rows.length]);
  useLayoutEffect(() => {
    requestVisible();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(requestVisible);
    observer.observe(element);
    return () => observer.disconnect();
  }, [requestVisible]);
  const sections = counts ? historyAgentCatalogSections(counts) : [];
  const totalHeight = counts ? counts.roster * ROW_HEIGHT + sections.length * HEADING_HEIGHT : 0;
  return <div ref={scroller} data-history-agent-catalog-scroll onScroll={requestVisible}
    style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' }}>
    {(!counts || counts.total === 0) && <div role="status" style={{ padding: '6px 10px', color: '#777', fontSize: '0.82em' }}>
      {status === 'error' ? 'Не удалось прочитать список агентов.'
        : status === 'pending' ? 'Загружаем список агентов…' : 'Агентов нет.'}
    </div>}
    {counts && counts.total > 0 && <div style={{ height: totalHeight, position: 'relative' }}>
      {sections.map(section => <div key={section.section} style={{ position: 'absolute', top: section.top,
        left: 0, right: 0, height: HEADING_HEIGHT, padding: '5px 10px 3px', boxSizing: 'border-box',
        color: '#666', fontSize: '0.72em', textTransform: 'uppercase', letterSpacing: 0.7 }}>
        {section.section} · {section.count}
      </div>)}
      {rows.map((row, index) => {
        const rank = pageStart + index;
        const section = sections.find(value => rank >= value.offset && rank < value.offset + value.count);
        if (!section) return null;
        return <div key={rank} data-history-agent-catalog-rank={rank} style={{ position: 'absolute',
          top: section.rowsTop + (rank - section.offset) * ROW_HEIGHT, left: 0, right: 0,
          height: ROW_HEIGHT, overflow: 'hidden' }}>{renderRow(row, rank)}</div>;
      })}
    </div>}
    {counts && counts.total > 0 && status !== 'ready' && <div role="status" title={error || undefined}
      style={{ position: 'sticky', bottom: 0, padding: '3px 10px', background: '#111', color: '#777', fontSize: '0.75em' }}>
      {status === 'error' ? 'Обновление списка недоступно.' : 'Загружаем…'}
    </div>}
  </div>;
}
