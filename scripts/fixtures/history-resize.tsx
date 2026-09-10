// Real divider + real History. Only transcript transport and placement glue
// are controlled. No provider process or user's saved layout is touched.
import React, { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { mountHistoryPreviewFixture } from './history-preview-reading';
import { SplitDividerLayer, splitPaneRectStyle } from '../../src/renderer/components/Workspace/SplitPaneChrome';
import { HISTORY_SURFACE_PRESENTATION_EVENT } from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';

export function mountHistoryResizeFixture(stacked: boolean | 'corner' = false) {
  const readerText = Array.from({ length: 600 }, (_, i) => `фрагмент${String(i).padStart(4, '0')}`).join(' ');
  const histories = Array.from({ length: stacked === 'corner' ? 3 : 2 }, () => mountHistoryPreviewFixture({ readerText }));
  const previous = useWorkspaceStore.getState();
  const panes = histories.map((f, i) => ({ projectId: `${f.id}-project`, tabId: f.tabId,
    column: stacked === 'corner' ? (i < 2 ? 0 : 1) : stacked ? 0 : i }));
  useWorkspaceStore.setState({ splitPanes: panes, splitSizes: null, splitFocusedIndex: 0 });
  const host = document.createElement('div');
  host.dataset.historyResizeFixture = histories[0].id;
  Object.assign(host.style, { position: 'fixed', top: '60px', left: '20px', width: '1220px', height: '950px', zIndex: '100001', background: '#151515' });
  document.body.appendChild(host);
  for (const f of histories) Object.assign(f.host.style, { position: 'relative', inset: '0', width: '100%', height: '100%', zIndex: 'auto' });
  const refs = histories.map((f) => (el: HTMLDivElement | null) => { if (el && f.host.parentElement !== el) el.appendChild(f.host); });
  function Grid() {
    const sizes = useWorkspaceStore((s) => s.splitSizes);
    const fingerprint = JSON.stringify(sizes);
    const prev = useRef(fingerprint);
    useLayoutEffect(() => {
      const geometryStable = prev.current === fingerprint;
      prev.current = fingerprint;
      histories.forEach((f, i) => window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT, {
        detail: { channel: `${f.id}:main`, presented: true, geometryStable, focused: i === 0 },
      })));
    }, [fingerprint]);
    return <>
      {histories.map((f, i) => <div key={f.id} data-terminal-pane-wrapper data-pane-event-index={i}
        style={{ position: 'absolute', ...splitPaneRectStyle(i, panes, sizes), zIndex: 1, overflow: 'hidden' }}>
        <div data-terminal-pane-content ref={refs[i]} style={{ position: 'absolute', inset: 0 }} />
      </div>)}
      <SplitDividerLayer />
    </>;
  }
  const root = createRoot(host);
  flushSync(() => root.render(<Grid />));
  return { host, histories,
    destroy() {
      flushSync(() => root.unmount());
      histories.forEach((f) => f.destroy());
      host.remove();
      useWorkspaceStore.setState({ splitPanes: previous.splitPanes, splitSizes: previous.splitSizes, splitFocusedIndex: previous.splitFocusedIndex });
    },
  };
}
