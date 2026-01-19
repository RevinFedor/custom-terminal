import React, { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface Command {
  name: string;
  command: string;
}

interface Prompt {
  title: string;
  content: string;
}

export default function SettingsPanel() {
  const { showToast } = useUIStore();

  const [commands, setCommands] = useState<Command[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [editingCommand, setEditingCommand] = useState<number | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<number | null>(null);
  const commandsSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const promptsSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadCommands();
    loadPrompts();
  }, []);

  const loadCommands = async () => {
    const result = await ipcRenderer.invoke('commands:get-global');
    if (result.success && result.data) {
      setCommands(result.data);
    }
  };

  const loadPrompts = async () => {
    const result = await ipcRenderer.invoke('prompts:get');
    if (result.success && result.data) {
      setPrompts(result.data);
    }
  };

  const saveCommands = (newCommands: Command[], silent = false) => {
    setCommands(newCommands);
    if (commandsSaveTimeoutRef.current) clearTimeout(commandsSaveTimeoutRef.current);
    commandsSaveTimeoutRef.current = setTimeout(async () => {
      await ipcRenderer.invoke('commands:save-global', newCommands);
      if (!silent) showToast('Saved', 'success');
    }, 800);
  };

  const addCommand = () => {
    const newCommands = [...commands, { name: `Command ${commands.length + 1}`, command: '' }];
    saveCommands(newCommands);
    setEditingCommand(newCommands.length - 1);
  };

  const updateCommand = (index: number, field: 'name' | 'command', value: string) => {
    const newCommands = [...commands];
    newCommands[index][field] = value;
    saveCommands(newCommands, true);
  };

  const deleteCommand = async (index: number) => {
    const newCommands = commands.filter((_, i) => i !== index);
    setCommands(newCommands);
    await ipcRenderer.invoke('commands:save-global', newCommands);
    showToast('Deleted', 'success');
    setEditingCommand(null);
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

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '32px 48px',
        backgroundColor: '#1a1a1a'
      }}
    >
      {/* Two Columns - 50/50 split */}
      <div style={{ display: 'flex', gap: '48px' }}>

        {/* Commands Column */}
        <div style={{ flex: '1 1 50%', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#fff', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>⚡</span> Quick Commands
            </h2>
            <button
              onClick={addCommand}
              style={{
                padding: '6px 14px',
                backgroundColor: '#0ea5e9',
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
            {commands.length === 0 ? (
              <div style={{
                padding: '32px',
                textAlign: 'center',
                color: '#555',
                fontSize: '13px',
                border: '2px dashed #333',
                borderRadius: '12px'
              }}>
                No commands yet
              </div>
            ) : (
              commands.map((cmd, index) => (
                <div
                  key={index}
                  onClick={() => editingCommand !== index && setEditingCommand(index)}
                  style={{
                    padding: '16px',
                    backgroundColor: editingCommand === index ? '#252525' : '#222',
                    border: editingCommand === index ? '2px solid #0ea5e9' : '2px solid #333',
                    borderRadius: '12px',
                    cursor: editingCommand === index ? 'default' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {editingCommand === index ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <input
                        type="text"
                        value={cmd.name}
                        onChange={(e) => updateCommand(index, 'name', e.target.value)}
                        placeholder="Command name"
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
                        value={cmd.command}
                        onChange={(e) => updateCommand(index, 'command', e.target.value)}
                        placeholder="Terminal command..."
                        rows={2}
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
                          onClick={(e) => { e.stopPropagation(); deleteCommand(index); }}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: 'transparent',
                            color: '#ef4444',
                            border: 'none',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }}
                        >
                          Delete
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingCommand(null); }}
                          style={{
                            padding: '6px 16px',
                            backgroundColor: '#0ea5e9',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }}
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: '14px', color: '#fff', fontWeight: '500', marginBottom: '4px' }}>{cmd.name}</div>
                      {cmd.command && (
                        <div style={{ fontSize: '12px', color: '#666', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cmd.command}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Prompts Column */}
        <div style={{ flex: '1 1 50%', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#fff', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>💬</span> AI Prompts
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
                          style={{
                            padding: '6px 12px',
                            backgroundColor: 'transparent',
                            color: '#ef4444',
                            border: 'none',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }}
                        >
                          Delete
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingPrompt(null); }}
                          style={{
                            padding: '6px 16px',
                            backgroundColor: '#8b5cf6',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }}
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
