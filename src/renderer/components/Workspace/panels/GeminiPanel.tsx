import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

const GEMINI_API_KEY = 'REDACTED_GEMINI_KEY';

interface HistoryItem {
  id: number;
  selected_text: string;
  prompt: string;
  response: string;
  timestamp: number;
}

interface GeminiPanelProps {
  projectPath: string;
  geminiPrompt?: string;
  getSelectedText?: () => string;
}

export default function GeminiPanel({ projectPath, geminiPrompt, getSelectedText }: GeminiPanelProps) {
  const { showToast } = useUIStore();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedItem, setExpandedItem] = useState<HistoryItem | null>(null);

  useEffect(() => {
    loadHistory();
  }, [projectPath]);

  const loadHistory = async () => {
    try {
      const result = await ipcRenderer.invoke('gemini:get-history', { dirPath: projectPath, limit: 50 });
      if (result.success && result.data) {
        setHistory(result.data);
      }
    } catch (err) {
      console.error('[Gemini] Error loading history:', err);
    }
  };

  const handleResearch = async () => {
    const selectedText = getSelectedText?.();
    if (!selectedText) {
      showToast('Select text in terminal first!', 'error');
      return;
    }

    setLoading(true);

    const prompt = geminiPrompt ||
      'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ';

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt + selectedText }] }]
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message || 'Unknown API Error');
      }

      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
        throw new Error('API returned empty or blocked response');
      }

      const responseText = data.candidates[0].content.parts[0].text;

      // Save to database
      await ipcRenderer.invoke('gemini:save-history', {
        dirPath: projectPath,
        selectedText,
        prompt,
        response: responseText
      });

      showToast('Research completed!', 'success');
      loadHistory();
    } catch (err: any) {
      console.error('[Gemini] API Error:', err);
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this search from history?')) return;

    await ipcRenderer.invoke('gemini:delete-history', id);
    setHistory(history.filter(h => h.id !== id));
    showToast('Deleted', 'success');
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (expandedItem) {
    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="px-3 py-2 bg-[#333] flex items-center justify-between shrink-0">
          <span className="text-[11px] text-accent uppercase font-bold">AI Response</span>
          <button
            className="text-[#888] hover:text-white text-lg"
            onClick={() => setExpandedItem(null)}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-3 p-2 bg-[#2d2d2d] rounded">
            <p className="text-[10px] text-[#666] uppercase mb-1">Selected Text ({expandedItem.selected_text.length} chars)</p>
            <p className="text-xs text-[#aaa] line-clamp-3">{expandedItem.selected_text}</p>
          </div>

          <div className="p-2 bg-[#2d2d2d] rounded border border-accent">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-accent uppercase font-bold">Response</p>
              <button
                className="text-[10px] text-[#666] hover:text-accent"
                onClick={() => handleCopy(expandedItem.response)}
              >
                Copy
              </button>
            </div>
            <p className="text-sm text-[#eee] whitespace-pre-wrap leading-relaxed">
              {expandedItem.response}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 bg-[#333] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase text-[#aaa]">AI History</span>
          <span className="text-[10px] text-accent">{history.length}</span>
        </div>
        <button
          className={`text-[10px] px-2 py-1 rounded ${
            loading
              ? 'bg-[#555] text-[#888] cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent/80'
          }`}
          onClick={handleResearch}
          disabled={loading}
        >
          {loading ? 'Searching...' : 'Research Selection'}
        </button>
      </div>

      {/* History List */}
      <div className="flex-1 overflow-y-auto p-2">
        {history.length === 0 ? (
          <p className="text-[#555] text-center mt-5 text-xs">
            No Gemini searches yet. Select text in terminal and click "Research Selection".
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {history.map((item) => (
              <div
                key={item.id}
                className="group bg-[#2d2d2d] border-l-2 border-l-accent rounded p-2 transition-all hover:bg-[#333] cursor-pointer"
                onClick={() => setExpandedItem(item)}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-[9px] text-[#666] shrink-0">{formatTime(item.timestamp)}</span>
                    <span className="text-[10px] text-[#888] truncate">{item.selected_text.length} chars</span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="text-[#666] hover:text-accent text-xs px-1"
                      onClick={(e) => { e.stopPropagation(); handleCopy(item.response); }}
                    >
                      📋
                    </button>
                    <button
                      className="text-[#666] hover:text-[#cc3333] text-xs px-1"
                      onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
                <div className="text-[10px] text-accent">✓ Done</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
