import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Search, Database, Loader2, X, ChevronDown, ChevronRight, Settings } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

interface SearchResult {
  text: string;
  score: number;
  sessionId: string;
  projectSlug: string;
  timestamp: string | null;
  startLine: number;
  endLine: number;
  tabName: string | null;
}

type DateFilter = '7d' | '30d' | '90d' | 'all';

const DATE_FILTER_LABELS: Record<DateFilter, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  'all': 'All time',
};

function getDateFrom(filter: DateFilter): string | null {
  if (filter === 'all') return null;
  const days = parseInt(filter);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function truncateSnippet(text: string, maxLen = 400): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function formatProjectSlug(slug: string): string {
  const parts = slug.replace(/^-/, '').split('-');
  return parts.length > 2 ? parts.slice(-2).join('/') : slug;
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

interface SemanticSearchSectionProps {
  projectPath: string;
}

export default memo(function SemanticSearchSection({ projectPath }: SemanticSearchSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [currentProjectOnly, setCurrentProjectOnly] = useState(true);
  const [indexStats, setIndexStats] = useState<{ chunkCount: number; fileCount: number; withEmbeddings: number } | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIndexSettings, setShowIndexSettings] = useState(false);
  const [sessionLimit, setSessionLimit] = useState<number>(10);
  const inputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Load index stats on mount
  useEffect(() => {
    ipcRenderer.invoke('search:stats').then((r: any) => {
      if (r.success) setIndexStats(r.data);
    });
  }, []);

  // Listen for indexing progress
  useEffect(() => {
    const handler = (_: any, data: any) => {
      setIndexProgress({ current: data.current, total: data.total });
    };
    ipcRenderer.on('search:index-progress', handler);
    return () => { ipcRenderer.removeListener('search:index-progress', handler); };
  }, []);

  // Focus input when section opens
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  const projectSlug = currentProjectOnly ? projectPath.replace(/\//g, '-') : null;

  const handleSearch = useCallback(async () => {
    if (!query.trim() || query.trim().length < 2) return;
    setSearching(true);
    setError(null);

    try {
      const r = await ipcRenderer.invoke('search:query', {
        query: query.trim(),
        maxResults: 30,
        minScore: 0.3,
        projectSlug,
        dateFrom: getDateFrom(dateFilter),
        dateTo: null,
      });

      if (r.success) {
        setResults(r.data);
      } else {
        setError(r.error || 'Search failed');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }, [query, projectSlug, dateFilter]);

  const handleIndexAll = useCallback(async (limit?: number) => {
    setIndexing(true);
    setIndexProgress(null);
    setShowIndexSettings(false);
    try {
      const r = await ipcRenderer.invoke('search:index-all', { limit: limit ?? 0 });
      if (r.success) {
        const stats = await ipcRenderer.invoke('search:stats');
        if (stats.success) setIndexStats(stats.data);
      } else {
        setError(r.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIndexing(false);
      setIndexProgress(null);
    }
  }, []);

  return (
    <div className="mt-6">
      {/* Header — collapsible */}
      <div className="flex items-center justify-between mb-3">
        <div
          className="flex items-center gap-2 cursor-pointer"
          style={{ display: 'inline-flex' }}
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? <ChevronDown size={14} className="text-[#888]" /> : <ChevronRight size={14} className="text-[#888]" />}
          <Search size={14} className="text-[#818cf8]" />
          <h2 className="text-sm text-[#888]">
            Session Search
            {indexStats && indexStats.chunkCount > 0 && (
              <span className="text-[#555] ml-1">({indexStats.chunkCount} chunks)</span>
            )}
          </h2>
        </div>

        {/* Index controls */}
        <div className="flex items-center gap-1 relative" ref={settingsRef}>
          {/* Settings gear */}
          <button
            onClick={(e) => { e.stopPropagation(); setShowIndexSettings(!showIndexSettings); }}
            className="flex items-center p-1 text-[#555] hover:text-[#999] cursor-pointer transition-colors"
            title="Index settings"
          >
            <Settings size={12} />
          </button>

          {/* Index button */}
          <button
            onClick={(e) => { e.stopPropagation(); handleIndexAll(sessionLimit); }}
            disabled={indexing}
            className="flex items-center gap-1 text-[11px] text-[#666] hover:text-[#999] cursor-pointer transition-colors"
            title={indexStats ? `${indexStats.fileCount} files, ${indexStats.chunkCount} chunks indexed` : 'Build search index'}
          >
            {indexing ? (
              <div className="w-2 h-2 rounded-full bg-[#818cf8] animate-glow-indigo shadow-[0_0_8px_rgba(129,140,248,0.5)]" />
            ) : (
              <Database size={12} />
            )}
            {indexing
              ? (indexProgress ? `${indexProgress.current}/${indexProgress.total}` : 'INDEXING...')
              : `Index (${sessionLimit || 'all'})`
            }
          </button>

          {/* Settings dropdown */}
          {showIndexSettings && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full mt-1 z-50 bg-[#2a2a2a] border border-[#444] rounded-md p-3 shadow-lg"
              style={{ minWidth: 180 }}
            >
              <div className="text-[11px] text-[#888] mb-2">Sessions to index (latest first)</div>
              <div className="flex gap-2 items-center mb-2">
                <input
                  type="number"
                  value={sessionLimit || ''}
                  onChange={(e) => setSessionLimit(parseInt(e.target.value) || 0)}
                  placeholder="0 = all"
                  min={0}
                  className="w-16 h-[22px] text-[11px] bg-[#1a1a1a] border border-[#444] rounded px-2 text-[#e0e0e0] outline-none focus:border-[#818cf8]"
                />
                <span className="text-[10px] text-[#666]">0 = all</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {[5, 10, 25, 50, 100].map(n => (
                  <button
                    key={n}
                    onClick={() => setSessionLimit(n)}
                    className={`px-2 py-0.5 text-[10px] rounded border cursor-pointer transition-colors ${
                      sessionLimit === n
                        ? 'bg-[#818cf8] text-white border-[#818cf8]'
                        : 'bg-transparent text-[#888] border-[#444] hover:text-white'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Collapsible body */}
      {isOpen && (
      <div>

        {/* Search input + filters */}
        <div className="flex gap-2 items-center mb-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleSearch(); }
            }}
            placeholder="Search across all sessions..."
            className="flex-1 h-[28px] text-xs bg-[#2a2a2a] border border-[#444] rounded px-2 text-[#e0e0e0] outline-none focus:border-[#818cf8]"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="h-[28px] px-3 text-[11px] font-medium bg-[#818cf8] text-white border-none rounded cursor-pointer disabled:opacity-50"
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        {/* Filters */}
        <div className="flex gap-3 items-center mb-3">
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as DateFilter)}
            className="h-[22px] text-[11px] bg-[#2a2a2a] text-[#aaa] border border-[#444] rounded px-1 outline-none"
          >
            {Object.entries(DATE_FILTER_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          <label className="text-[11px] text-[#888] flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={currentProjectOnly}
              onChange={(e) => setCurrentProjectOnly(e.target.checked)}
              className="w-3 h-3 accent-[#818cf8]"
            />
            This project only
          </label>
        </div>

        {/* Error */}
        {error && (
          <div className="text-[12px] text-red-400 mb-2">{error}</div>
        )}

        {/* Loading */}
        {searching && (
          <div className="flex items-center justify-center py-4 text-[#818cf8] text-xs gap-2">
            <Loader2 size={14} style={{ animation: 'spinner-rotate 1s linear infinite' }} />
            Searching...
          </div>
        )}

        {/* Empty states */}
        {!searching && results.length === 0 && query.trim() && !error && (
          <div className="text-[12px] text-[#555] text-center py-4">No results found</div>
        )}

        {!searching && results.length === 0 && !query.trim() && (
          <div className="text-[12px] text-[#555] text-center py-3">
            {indexStats && indexStats.chunkCount > 0
              ? `${indexStats.chunkCount} chunks across ${indexStats.fileCount} sessions. Type a query.`
              : 'No sessions indexed. Click "Index" to build the search index.'
            }
          </div>
        )}

        {/* Results — scrollable container */}
        {results.length > 0 && (
          <div>
            <div className="text-[11px] text-[#666] mb-1">{results.length} results</div>
            <div
              className="flex flex-col gap-2"
              style={{ maxHeight: '50vh', overflowY: 'auto', paddingRight: 2 }}
            >
              {results.map((result, i) => (
                <div
                  key={`${result.sessionId}-${result.startLine}-${i}`}
                  className="p-2 bg-[#232328] rounded-md border border-[#333]"
                >
                  {/* Header */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-medium text-[#818cf8]">
                      {(result.score * 100).toFixed(0)}%
                    </span>
                    <span className="text-[10px] text-[#666]">
                      {formatRelativeTime(result.timestamp)}
                    </span>
                    {result.tabName && (
                      <span className="text-[10px] text-[#DA7756] ml-auto truncate" style={{ maxWidth: 120 }}>
                        {result.tabName}
                      </span>
                    )}
                    <span className={`text-[10px] text-[#555] ${result.tabName ? '' : 'ml-auto'}`}>
                      {formatProjectSlug(result.projectSlug)}
                    </span>
                  </div>
                  {/* Snippet */}
                  <div className="text-[12px] text-[#ccc] whitespace-pre-wrap leading-relaxed">
                    {truncateSnippet(result.text)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
});
