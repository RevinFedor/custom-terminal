import React, { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { usePromptsStore, AIPrompt } from '../../store/usePromptsStore';

const { ipcRenderer } = window.require('electron');

interface Prompt {
  title: string;
  content: string;
}

export default function PromptsPanel() {
  const {
    showToast,
    docPrompt,
    setDocPromptUseFile,
    setDocPromptFilePath,
    setDocPromptInlineContent
  } = useUIStore();

  const { prompts: aiPrompts, savePrompt: saveAIPrompt, getPromptById } = usePromptsStore();

  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [editingPrompt, setEditingPrompt] = useState<number | null>(null);
  const [editingAIPromptId, setEditingAIPromptId] = useState<string | null>(null);
  const [localAIPromptContent, setLocalAIPromptContent] = useState('');
  const [editingDocPrompt, setEditingDocPrompt] = useState(false);
  const [localDocFilePath, setLocalDocFilePath] = useState(docPrompt.filePath);
  const [localDocInlineContent, setLocalDocInlineContent] = useState(docPrompt.inlineContent);
  const promptsSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const aiPromptSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    const result = await ipcRenderer.invoke('prompts:get');
    if (result.success && result.data) {
      setPrompts(result.data);
    }
  };

  const savePrompts = (newPrompts: Prompt[], silent = false) => {
    setPrompts(newPrompts);
    if (promptsSaveTimeoutRef.current) clearTimeout(promptsSaveTimeoutRef.current);
    promptsSaveTimeoutRef.current = setTimeout(async () => {
      await ipcRenderer.invoke('prompts:save', newPrompts);
      if (!silent) showToast('Saved', 'success');
    }, 800);
  };

  const addPrompt = () => {
    const newPrompts = [...prompts, { title: `Prompt ${prompts.length + 1}`, content: '' }];
    savePrompts(newPrompts);
    setEditingPrompt(newPrompts.length - 1);
  };

  const updatePrompt = (index: number, field: 'title' | 'content', value: string) => {
    const newPrompts = [...prompts];
    newPrompts[index][field] = value;
    savePrompts(newPrompts, true);
  };

  const deletePrompt = async (index: number) => {
    const newPrompts = prompts.filter((_, i) => i !== index);
    setPrompts(newPrompts);
    await ipcRenderer.invoke('prompts:save', newPrompts);
    showToast('Deleted', 'success');
    setEditingPrompt(null);
  };

  const startEditingAIPrompt = (prompt: AIPrompt) => {
    setEditingAIPromptId(prompt.id);
    setLocalAIPromptContent(prompt.content);
  };

  const updateAIPromptContent = (value: string) => {
    setLocalAIPromptContent(value);
    if (aiPromptSaveTimeoutRef.current) clearTimeout(aiPromptSaveTimeoutRef.current);
    aiPromptSaveTimeoutRef.current = setTimeout(() => {
      const prompt = getPromptById(editingAIPromptId || '');
      if (prompt) {
        saveAIPrompt({ ...prompt, content: value });
        showToast('Saved', 'success');
      }
    }, 800);
  };

  const docPromptSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const updateDocFilePath = (value: string) => {
    setLocalDocFilePath(value);
    if (docPromptSaveTimeoutRef.current) clearTimeout(docPromptSaveTimeoutRef.current);
    docPromptSaveTimeoutRef.current = setTimeout(() => {
      setDocPromptFilePath(value);
      showToast('Saved', 'success');
    }, 800);
  };

  const updateDocInlineContent = (value: string) => {
    setLocalDocInlineContent(value);
    if (docPromptSaveTimeoutRef.current) clearTimeout(docPromptSaveTimeoutRef.current);
    docPromptSaveTimeoutRef.current = setTimeout(() => {
      setDocPromptInlineContent(value);
      showToast('Saved', 'success');
    }, 800);
  };

  const DEFAULT_DOC_FILE_PATH = '/Users/fedor/Global-Templates/🧩 Code-Patterns/документация/docs-rules.prompt.md';

  const resetDocPrompt = () => {
    setLocalDocFilePath(DEFAULT_DOC_FILE_PATH);
    setDocPromptFilePath(DEFAULT_DOC_FILE_PATH);
    setLocalDocInlineContent('');
    setDocPromptInlineContent('');
    setDocPromptUseFile(true);
    showToast('Reset to default', 'success');
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '32px 48px',
        backgroundColor: '#1a1a1a'
      }}
    >
      {/* Two Columns */}
      <div style={{ display: 'flex', gap: '48px' }}>

        {/* AI Prompts Column */}
        <div style={{ flex: '1 1 50%', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#fff', margin: 0 }}>
              AI Prompts
            </h2>
          </div>

          {/* Dynamic AI Prompts */}
          {aiPrompts.map((aiPrompt) => {
            const isEditing = editingAIPromptId === aiPrompt.id;
            return (
              <div
                key={aiPrompt.id}
                onClick={() => !isEditing && startEditingAIPrompt(aiPrompt)}
                style={{
                  padding: '16px',
                  backgroundColor: isEditing ? '#252525' : '#222',
                  border: isEditing ? `2px solid ${aiPrompt.color}` : `2px solid ${aiPrompt.color}33`,
                  borderRadius: '12px',
                  cursor: isEditing ? 'default' : 'pointer',
                  marginBottom: '12px'
                }}
              >
                {isEditing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <textarea
                      value={localAIPromptContent}
                      onChange={(e) => updateAIPromptContent(e.target.value)}
                      rows={4}
                      autoFocus
                      style={{ width: '100%', padding: '10px 12px', backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '8px', color: '#aaa', fontSize: '12px', fontFamily: 'monospace', outline: 'none', resize: 'none', boxSizing: 'border-box' as const }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingAIPromptId(null); }}
                        style={{ padding: '6px 16px', backgroundColor: aiPrompt.color, color: '#fff', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <div style={{ fontSize: '14px', color: aiPrompt.color, fontWeight: '500' }}>{aiPrompt.name}</div>
                      <span style={{ fontSize: '9px', padding: '2px 6px', backgroundColor: `${aiPrompt.color}22`, color: aiPrompt.color, borderRadius: '4px' }}>
                        {aiPrompt.model.includes('pro') ? 'PRO' : 'FLASH'}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
                      {aiPrompt.content}
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {/* Documentation Prompt */}
          <div
            onClick={() => !editingDocPrompt && setEditingDocPrompt(true)}
            style={{
              padding: '16px',
              backgroundColor: editingDocPrompt ? '#252525' : '#222',
              border: editingDocPrompt ? '2px solid #22c55e' : '2px solid #22c55e33',
              borderRadius: '12px',
              cursor: editingDocPrompt ? 'default' : 'pointer'
            }}
          >
            {editingDocPrompt ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: '#888' }}>Source:</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(true); }}
                    style={{
                      padding: '4px 12px',
                      backgroundColor: docPrompt.useFile ? '#22c55e' : '#333',
                      color: docPrompt.useFile ? '#fff' : '#888',
                      border: 'none',
                      borderRadius: '4px',
                      fontSize: '11px',
                      cursor: 'pointer'
                    }}
                  >
                    File
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDocPromptUseFile(false); }}
                    style={{
                      padding: '4px 12px',
                      backgroundColor: !docPrompt.useFile ? '#22c55e' : '#333',
                      color: !docPrompt.useFile ? '#fff' : '#888',
                      border: 'none',
                      borderRadius: '4px',
                      fontSize: '11px',
                      cursor: 'pointer'
                    }}
                  >
                    Inline
                  </button>
                </div>

                {docPrompt.useFile ? (
                  <input
                    type="text"
                    value={localDocFilePath}
                    onChange={(e) => updateDocFilePath(e.target.value)}
                    placeholder="Path to prompt file..."
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #444',
                      borderRadius: '8px',
                      color: '#aaa',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      outline: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                ) : (
                  <textarea
                    value={localDocInlineContent}
                    onChange={(e) => updateDocInlineContent(e.target.value)}
                    rows={6}
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #444',
                      borderRadius: '8px',
                      color: '#aaa',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      outline: 'none',
                      resize: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); resetDocPrompt(); }}
                    style={{ padding: '6px 12px', backgroundColor: 'transparent', color: '#888', border: 'none', fontSize: '12px', cursor: 'pointer' }}
                  >
                    Reset
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingDocPrompt(false); }}
                    style={{ padding: '6px 16px', backgroundColor: '#22c55e', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <div style={{ fontSize: '14px', color: '#22c55e', fontWeight: '500' }}>Documentation</div>
                  <span style={{
                    fontSize: '9px',
                    padding: '2px 6px',
                    backgroundColor: docPrompt.useFile ? '#22c55e22' : '#8b5cf622',
                    color: docPrompt.useFile ? '#22c55e' : '#8b5cf6',
                    borderRadius: '4px'
                  }}>
                    {docPrompt.useFile ? 'FILE' : 'INLINE'}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {docPrompt.useFile ? localDocFilePath : (localDocInlineContent || 'No content')}
                </div>
              </>
            )}
          </div>
        </div>

        {/* User Prompts Column */}
        <div style={{ flex: '1 1 50%', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#fff', margin: 0 }}>
              Context Menu Prompts
            </h2>
            <button
              onClick={addPrompt}
              style={{
                padding: '6px 14px',
                backgroundColor: '#8b5cf6',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: '500',
                cursor: 'pointer'
              }}
            >
              + Add
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {prompts.length === 0 ? (
              <div style={{
                padding: '32px',
                textAlign: 'center',
                color: '#555',
                fontSize: '13px',
                border: '2px dashed #333',
                borderRadius: '12px'
              }}>
                No prompts yet
              </div>
            ) : (
              prompts.map((prompt, index) => (
                <div
                  key={index}
                  onClick={() => editingPrompt !== index && setEditingPrompt(index)}
                  style={{
                    padding: '16px',
                    backgroundColor: editingPrompt === index ? '#252525' : '#222',
                    border: editingPrompt === index ? '2px solid #8b5cf6' : '2px solid #333',
                    borderRadius: '12px',
                    cursor: editingPrompt === index ? 'default' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {editingPrompt === index ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <input
                        type="text"
                        value={prompt.title}
                        onChange={(e) => updatePrompt(index, 'title', e.target.value)}
                        placeholder="Prompt title"
                        autoFocus
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #444',
                          borderRadius: '8px',
                          color: '#fff',
                          fontSize: '14px',
                          outline: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                      <textarea
                        value={prompt.content}
                        onChange={(e) => updatePrompt(index, 'content', e.target.value)}
                        placeholder="Prompt content..."
                        rows={3}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #444',
                          borderRadius: '8px',
                          color: '#aaa',
                          fontSize: '12px',
                          fontFamily: 'monospace',
                          outline: 'none',
                          resize: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); deletePrompt(index); }}
                          style={{ padding: '6px 12px', backgroundColor: 'transparent', color: '#ef4444', border: 'none', fontSize: '12px', cursor: 'pointer' }}
                        >
                          Delete
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingPrompt(null); }}
                          style={{ padding: '6px 16px', backgroundColor: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: '14px', color: '#fff', fontWeight: '500', marginBottom: '4px' }}>{prompt.title}</div>
                      {prompt.content && (
                        <div style={{ fontSize: '12px', color: '#666', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                          {prompt.content}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
