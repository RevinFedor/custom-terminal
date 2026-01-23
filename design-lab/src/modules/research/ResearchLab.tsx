/**
 * RESEARCH LAB
 *
 * Тестовая страница для отладки AI чат-интерфейса.
 * Здесь можно тестировать:
 * - Markdown рендеринг
 * - Стриминг ответов
 * - Смену моделей
 * - UI/UX чата
 */

import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import {
  Send,
  Trash2,
  Settings,
  ChevronDown,
  X,
  Key,
  Zap,
  AlertCircle,
} from 'lucide-react';
import ChatArea from './components/ChatArea';
import { useResearchStore } from './store/useResearchStore';

// ============================================================================
// КОНФИГУРАЦИЯ МОДЕЛЕЙ
// Добавляй новые модели сюда
// ============================================================================
const MODELS = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Быстрый, дешёвый' },
  { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash Preview', description: 'Новейший' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Умный, дорогой' },
];

// ============================================================================
// SETTINGS PANEL
// ============================================================================
function SettingsPanel({
  apiKey,
  setApiKey,
  model,
  setModel,
  onClose,
}: {
  apiKey: string;
  setApiKey: (key: string) => void;
  model: string;
  setModel: (model: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute top-0 right-0 w-80 h-full bg-[#1a1a1b] border-l border-[#333] z-20 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-[#333]">
        <h3 className="text-sm font-semibold text-white">Settings</h3>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-white hover:bg-[#333] rounded transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 p-4 space-y-6 overflow-y-auto">
        {/* API Key */}
        <div>
          <label className="flex items-center gap-2 text-xs font-medium text-gray-400 mb-2">
            <Key size={14} />
            Google AI API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="AIza..."
            className="w-full px-3 py-2 bg-[#0c0c0c] border border-[#333] rounded-lg text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#a8c7fa]/50"
          />
          <p className="mt-1.5 text-[10px] text-gray-600">
            Получи ключ на{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener"
              className="text-[#a8c7fa] hover:underline"
            >
              aistudio.google.com
            </a>
          </p>
        </div>

        {/* Model Selection */}
        <div>
          <label className="flex items-center gap-2 text-xs font-medium text-gray-400 mb-2">
            <Zap size={14} />
            Model
          </label>
          <div className="space-y-2">
            {MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all text-left ${
                  model === m.id
                    ? 'bg-[#a8c7fa]/10 border-[#a8c7fa]/30 text-white'
                    : 'bg-[#0c0c0c] border-[#333] text-gray-400 hover:border-[#444]'
                }`}
              >
                <div>
                  <div className="text-sm font-medium">{m.name}</div>
                  <div className="text-[10px] text-gray-500">{m.description}</div>
                </div>
                {model === m.id && (
                  <div className="w-2 h-2 bg-[#a8c7fa] rounded-full" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function ResearchLab() {
  // State
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini-api-key') || '');
  const [model, setModel] = useState(() => localStorage.getItem('gemini-model') || MODELS[0].id);
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Store
  const { messages, addMessage, updateLastMessage, clearChat, isLoading, setLoading } =
    useResearchStore();

  // Persist settings
  useEffect(() => {
    localStorage.setItem('gemini-api-key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem('gemini-model', model);
  }, [model]);

  // ============================================================================
  // SEND MESSAGE
  // ============================================================================
  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    if (!apiKey) {
      setError('Укажи API ключ в настройках');
      setShowSettings(true);
      return;
    }

    setError(null);
    const userMessage = input.trim();
    setInput('');
    addMessage('user', userMessage);
    setLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey });

      // Собираем историю для контекста
      const history = messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      }));

      // Добавляем текущее сообщение
      history.push({ role: 'user', parts: [{ text: userMessage }] });

      // Создаём placeholder для ответа
      addMessage('assistant', '');

      // Стриминг
      const response = await ai.models.generateContentStream({
        model,
        contents: history,
      });

      let fullText = '';
      for await (const chunk of response) {
        const text = chunk.text || '';
        fullText += text;
        updateLastMessage(fullText);
      }
    } catch (err: any) {
      console.error('Gemini error:', err);
      setError(err.message || 'Ошибка при запросе к Gemini API');
      // Удаляем пустой placeholder если была ошибка
      // (в реальном приложении нужна более сложная логика)
    } finally {
      setLoading(false);
    }
  };

  // ============================================================================
  // KEYBOARD HANDLER
  // ============================================================================
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================
  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#333] bg-[#1a1a1b]">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white">Research Chat</h2>
          <span className="text-[10px] px-2 py-0.5 bg-[#333] rounded text-gray-400">
            {MODELS.find((m) => m.id === model)?.name || model}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={clearChat}
            className="p-2 text-gray-500 hover:text-red-400 hover:bg-[#333] rounded-lg transition-colors"
            title="Очистить чат"
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2 rounded-lg transition-colors ${
              showSettings
                ? 'text-[#a8c7fa] bg-[#a8c7fa]/10'
                : 'text-gray-500 hover:text-white hover:bg-[#333]'
            }`}
            title="Настройки"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto hover:text-red-300">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Chat Area */}
      <div className="flex-1 overflow-hidden">
        <ChatArea />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-[#333] bg-[#1a1a1b]">
        <div className="flex gap-3 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Напиши сообщение... (Enter для отправки, Shift+Enter для переноса)"
            rows={1}
            className="flex-1 px-4 py-3 bg-[#0c0c0c] border border-[#333] rounded-xl text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#a8c7fa]/50 resize-none"
            style={{ minHeight: '48px', maxHeight: '200px' }}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="px-4 py-3 bg-[#a8c7fa] hover:bg-[#c2d7f8] disabled:bg-[#333] disabled:text-gray-600 text-black rounded-xl font-semibold text-sm transition-colors flex items-center gap-2"
          >
            <Send size={16} />
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <SettingsPanel
          apiKey={apiKey}
          setApiKey={setApiKey}
          model={model}
          setModel={setModel}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
