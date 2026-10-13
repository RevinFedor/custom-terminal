import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Globe } from 'lucide-react';
import { Markdown } from '@noted/claude-blocks';
import './ResearchResultContent.css';

/** Host owns disclosure, raw Copy and saved-job navigation. No new reader or
 * lifecycle here; the bounded body follows the existing MCP output metrics. */
export function ResearchResultContent({ result, open, onToggle, title, model, sourceAction, browserAction, onCopy, copied, forceExpanded = false }: {
  result: { previewText: string; displayText: string; summary: string | null; code: string | null; failed?: boolean };
  open: boolean; onToggle: () => void; title?: string | null; model?: string | null; sourceAction?: React.ReactNode;
  browserAction?: React.ReactNode;
  onCopy: (event: React.MouseEvent<HTMLButtonElement>) => void; copied: boolean; forceExpanded?: boolean;
}) {
  const hasBody = !!result.displayText.trim();
  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation(); if (hasBody && !forceExpanded) onToggle();
  };
  return <div className="hp-research-result" data-history-research-result
    data-research-expanded={open} data-research-failed={result.failed || undefined}>
    <div className="hp-research-result-header">
      <button type="button" className="hp-research-result-toggle" disabled={!hasBody || forceExpanded}
        aria-label={`${open ? 'Collapse' : 'Expand'} Research answer${title ? ': ' + title : ''}`}
        aria-expanded={open} onClick={toggle}>
        <Globe size={14} strokeWidth={2.5} className="hp-research-result-icon" aria-hidden="true" />
        <span className="cb-tool-label hp-research-result-label">Research</span>
        {model && <span className="hp-research-result-model">· {model}</span>}
        <span className="hp-research-result-flex" />
      </button>
      <div className="hp-research-result-actions">
        {sourceAction}
        {browserAction}
        <button type="button" aria-label={copied ? 'Copied' : 'Copy original answer'}
          title={copied ? 'Copied' : 'Copy original answer'} onMouseDown={e => e.stopPropagation()} onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        {hasBody && !forceExpanded && <button type="button" data-research-disclosure
          aria-label={open ? 'Collapse answer' : 'Expand answer'} aria-expanded={open} onClick={toggle}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>}
      </div>
    </div>
    {open ? <div className="hp-research-result-body" data-research-full tabIndex={0} aria-label="Research answer">
      {result.summary && <div className="hp-research-result-format">{result.summary}</div>}
      {typeof result.code === 'string' ? <pre className="cb-generic-out hp-research-result-code">{result.code}</pre>
        : <Markdown text={result.displayText} />}
    </div> : result.previewText && <div className="hp-history-group-detail hp-research-result-preview" data-research-preview>
      <span aria-hidden="true">└</span><div className="hp-research-result-excerpt">
        {result.code === null ? <Markdown text={result.previewText} /> : result.previewText}
      </div>
    </div>}
  </div>;
}
