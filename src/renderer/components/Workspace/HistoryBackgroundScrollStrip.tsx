import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { bindHistoryBackgroundScroll } from '../../utils/historyBackgroundScroll.mjs';
import './HistoryBackgroundScrollStrip.css';

export function HistoryBackgroundScrollStrip({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof bindHistoryBackgroundScroll> | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    if (!root.current || !viewport.current || !content.current) return;
    const binding = bindHistoryBackgroundScroll({ viewport: viewport.current, content: content.current,
      wheelHost: root.current, onEdges: setEdges });
    controller.current = binding;
    return () => { controller.current = null; binding.dispose(); };
  }, []);
  return <div ref={root} className="hp-background-scroll-strip" data-history-background-scroll>
    <div ref={viewport} className="hp-background-scroll-viewport" data-history-background-tasks>
      <div ref={content} className="hp-background-scroll-content">{children}</div>
    </div>
    {(['left', 'right'] as const).map(side => edges[side] && <button key={side} type="button"
      className={`hp-background-scroll-arrow hp-background-scroll-arrow--${side}`}
      data-history-background-scroll-arrow={side} aria-label={`Scroll agents ${side}`}
      title={`Scroll agents ${side}`} onMouseDown={event => event.preventDefault()}
      onClick={event => { event.stopPropagation(); controller.current?.step(side === 'left' ? -1 : 1); }}>
      {side === 'left' ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
    </button>)}
  </div>;
}
