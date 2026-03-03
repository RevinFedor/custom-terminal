import React from 'react';
import { useUIStore, ApiClaudeModel, ApiGeminiModel, ThinkingLevel } from '../../store/useUIStore';

const CLAUDE_MODELS: { id: ApiClaudeModel; label: string }[] = [
  { id: 'claude-sonnet-4.5', label: 'Sonnet 4.5' },
  { id: 'claude-opus-4.6', label: 'Opus 4.6' },
];

const GEMINI_MODELS: { id: ApiGeminiModel; label: string }[] = [
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
];

const THINKING_LEVELS: { id: ThinkingLevel; label: string }[] = [
  { id: 'NONE', label: 'Off' },
  { id: 'LOW', label: 'Low' },
  { id: 'MEDIUM', label: 'Med' },
  { id: 'HIGH', label: 'High' },
];

export default function ApiSettingsModal() {
  const { apiSettingsOpen, closeApiSettings, apiSettings, setApiClaudeModel, setApiGeminiModel, setApiGeminiThinking } = useUIStore();

  if (!apiSettingsOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={closeApiSettings}
    >
      <div
        style={{
          backgroundColor: '#1a1a1a',
          borderRadius: '16px',
          border: '1px solid #333',
          width: '360px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <h2 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#fff' }}>
            API Settings
          </h2>
          <button
            onClick={closeApiSettings}
            style={{
              background: 'none',
              border: 'none',
              color: '#666',
              fontSize: '18px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Claude Section */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#DA7756', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Claude</span>
              <div style={{ flex: 1, height: '1px', backgroundColor: '#333' }} />
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {CLAUDE_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setApiClaudeModel(m.id)}
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    fontSize: '11px',
                    fontWeight: 500,
                    border: '1px solid',
                    borderColor: apiSettings.claudeModel === m.id ? '#DA7756' : '#333',
                    borderRadius: '6px',
                    backgroundColor: apiSettings.claudeModel === m.id ? 'rgba(218, 119, 86, 0.15)' : 'transparent',
                    color: apiSettings.claudeModel === m.id ? '#DA7756' : '#888',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Gemini Section */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#4E86F8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Gemini</span>
              <div style={{ flex: 1, height: '1px', backgroundColor: '#333' }} />
            </div>

            {/* Model */}
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', color: '#666', marginBottom: '6px' }}>Model</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {GEMINI_MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setApiGeminiModel(m.id)}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      fontSize: '11px',
                      fontWeight: 500,
                      border: '1px solid',
                      borderColor: apiSettings.geminiModel === m.id ? '#4E86F8' : '#333',
                      borderRadius: '6px',
                      backgroundColor: apiSettings.geminiModel === m.id ? 'rgba(78, 134, 248, 0.15)' : 'transparent',
                      color: apiSettings.geminiModel === m.id ? '#4E86F8' : '#888',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Thinking */}
            <div>
              <div style={{ fontSize: '10px', color: '#666', marginBottom: '6px' }}>Thinking</div>
              <div style={{ display: 'flex', gap: '4px' }}>
                {THINKING_LEVELS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setApiGeminiThinking(t.id)}
                    style={{
                      flex: 1,
                      padding: '5px 6px',
                      fontSize: '10px',
                      fontWeight: 500,
                      border: '1px solid',
                      borderColor: apiSettings.geminiThinking === t.id ? '#4E86F8' : '#333',
                      borderRadius: '6px',
                      backgroundColor: apiSettings.geminiThinking === t.id ? 'rgba(78, 134, 248, 0.15)' : 'transparent',
                      color: apiSettings.geminiThinking === t.id ? '#4E86F8' : '#888',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer hint */}
        <div style={{
          padding: '10px 20px 14px',
          borderTop: '1px solid #282828',
          fontSize: '10px',
          color: '#555',
          textAlign: 'center',
        }}>
          Used by <code style={{ color: '#a78bfa', fontSize: '10px' }}>api</code> button in System panel
        </div>
      </div>
    </div>
  );
}
