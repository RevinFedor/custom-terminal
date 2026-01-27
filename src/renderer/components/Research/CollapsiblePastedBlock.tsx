import React, { useState } from 'react';
import { ChevronRight, ChevronDown, ClipboardPaste } from 'lucide-react';

interface CollapsiblePastedBlockProps {
  content: string;
}

export default function CollapsiblePastedBlock({ content }: CollapsiblePastedBlockProps) {
  const [expanded, setExpanded] = useState(false);

  // Count lines for preview
  const lines = content.split('\n');
  const lineCount = lines.length;
  const charCount = content.length;

  // Preview: first line truncated
  const preview = lines[0].slice(0, 60) + (lines[0].length > 60 ? '...' : '');

  return (
    <div className="my-3 rounded-lg border border-[#333] bg-[#1a1a1a] overflow-hidden">
      {/* Header - always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#252525] transition-colors cursor-pointer"
      >
        {/* Expand icon */}
        {expanded ? (
          <ChevronDown size={14} className="text-[#666] shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-[#666] shrink-0" />
        )}

        {/* Pasted icon */}
        <ClipboardPaste size={12} className="text-accent shrink-0" />

        {/* Label and preview */}
        <span className="text-[10px] text-accent font-medium uppercase shrink-0">Pasted</span>

        {!expanded && (
          <span className="text-[11px] text-[#666] truncate flex-1 font-mono">
            {preview}
          </span>
        )}

        {/* Stats */}
        <span className="text-[9px] text-[#555] shrink-0 ml-auto">
          {lineCount} lines / {charCount > 1000 ? `${(charCount / 1000).toFixed(1)}K` : charCount} chars
        </span>
      </button>

      {/* Content - collapsible */}
      {expanded && (
        <div className="border-t border-[#333]">
          <pre className="p-3 text-[11px] text-[#999] font-mono whitespace-pre-wrap overflow-x-auto max-h-[400px] overflow-y-auto">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
