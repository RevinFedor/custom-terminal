import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { Folder, CheckCircle2, AlertCircle, Trash2, Plus, X, MessageSquareQuote } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import SmartPopover from './SmartPopover';
import ControlHint from './ControlHint';

const { ipcRenderer } = window.require('electron');

export default function EditProjectModal() {
  const { editingProject, closeEditModal, showToast } = useUIStore();
  const { loadProjects, updateProject } = useProjectsStore();
  const { openProjects, closeProject } = useWorkspaceStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [isPathValid, setIsPathValid] = useState<boolean | null>(null);
  const [isHoveringName, setIsHoveringName] = useState(false);
  const [section, setSection] = useState<'general' | 'prompts'>('general');
  const [promptSourceInput, setPromptSourceInput] = useState('');
  const [promptSources, setPromptSources] = useState<any[]>([]);
  const [promptSourcesLoading, setPromptSourcesLoading] = useState(false);

  useEffect(() => {
    if (editingProject) {
      setName(editingProject.name || '');
      setDescription(editingProject.description || '');
      setPath(editingProject.path || '');
      setIsPathValid(null);
      setSection('general');
      setPromptSourceInput('');
    }
  }, [editingProject]);

  const loadPromptSources = async (projectId: string) => {
    setPromptSourcesLoading(true);
    try {
      const [sourcesResult, catalogResult] = await Promise.all([
        ipcRenderer.invoke('project-prompts:get-sources', projectId),
        ipcRenderer.invoke('project-prompts:list', projectId),
      ]);
      const counts = new Map<string, number>(
        (catalogResult?.success ? catalogResult.data?.sources || [] : [])
          .map((source: any) => [source.rootPath, Number(source.promptCount) || 0]),
      );
      const sources = sourcesResult?.success ? sourcesResult.data || [] : [];
      setPromptSources(sources.map((source: any) => ({
        ...source,
        promptCount: counts.get(source.rootPath) || 0,
      })));
    } catch (error: any) {
      showToast(`Не удалось загрузить папки промптов: ${error?.message || error}`, 'error');
    } finally {
      setPromptSourcesLoading(false);
    }
  };

  useEffect(() => {
    if (!editingProject?.id) return;
    void loadPromptSources(editingProject.id);
  }, [editingProject?.id]);

  // Save everything when modal closes (onUnmount)
  useEffect(() => {
    return () => {
      if (editingProject) {
        handleSave(true); // Silent save on close
      }
    };
  }, [editingProject, name, description, path]);

  const validatePath = async (p: string) => {
    if (!p || !p.trim()) {
      setIsPathValid(false);
      return false;
    }
    const exists = await ipcRenderer.invoke('app:check-path-exists', p.trim());
    setIsPathValid(exists);
    return exists;
  };

  const handleSelectDirectory = async () => {
    const selected = await ipcRenderer.invoke('app:select-directory');
    if (selected) {
      setPath(selected);
      validatePath(selected);
      handleSave(false, selected);
    }
  };

  const savePromptSourceRoots = async (roots: string[]) => {
    if (!editingProject) return false;
    const result = await ipcRenderer.invoke('project-prompts:set-sources', {
      projectId: editingProject.id,
      roots,
    });
    if (!result?.success) {
      const overlap = result?.code === 'overlapping_prompt_sources' && Array.isArray(result.paths)
        ? `: ${result.paths.join(' ↔ ')}`
        : '';
      showToast(`Не удалось сохранить папки промптов${overlap}`, 'error');
      return false;
    }
    await loadPromptSources(editingProject.id);
    return true;
  };

  const addPromptSource = async (rawPath = promptSourceInput) => {
    const nextPath = String(rawPath || '').trim();
    if (!nextPath) return;
    const roots = [...promptSources.map((source) => source.rootPath), nextPath];
    if (await savePromptSourceRoots(roots)) {
      setPromptSourceInput('');
      showToast('Папка проектных промптов добавлена', 'success');
    }
  };

  const handleSelectPromptDirectory = async () => {
    const selected = await ipcRenderer.invoke('app:select-directory');
    if (selected) await addPromptSource(selected);
  };

  const removePromptSource = async (rootPath: string) => {
    const roots = promptSources
      .map((source) => source.rootPath)
      .filter((candidate) => candidate !== rootPath);
    await savePromptSourceRoots(roots);
  };

  const handleSave = async (silent = false, pathOverride = path) => {
    if (!editingProject) return;
    if (!name.trim()) return;

    // For projects, path validation is more critical
    await updateProject(editingProject.id, {
      name: name.trim(),
      description: description.trim(),
      path: pathOverride.trim()
    });

    if (!silent) {
      // Notify other components (like ProjectHome) about name change
      window.dispatchEvent(new CustomEvent('project:name-sync', { 
        detail: { projectId: editingProject.id, name: name.trim() } 
      }));
    }
  };

  const handleDelete = async () => {
    if (!editingProject) return;

    if (!confirm(`Delete project "${editingProject.name}"?`)) return;

    if (openProjects.has(editingProject.id)) {
      await closeProject(editingProject.id);
    }
    const result = await ipcRenderer.invoke('project:delete', editingProject.id);
    if (result.success) {
      showToast('Project deleted', 'success');
      loadProjects();
    }
    closeEditModal();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeEditModal();
    }
  };

  if (!editingProject) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]"
      onClick={closeEditModal}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-[460px] max-h-[78vh] overflow-hidden shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Right Controls */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <ControlHint label="Удалить проект">
            <button
              className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-full transition-all cursor-pointer"
              onClick={handleDelete}
            >
              <Trash2 size={16} />
            </button>
          </ControlHint>
          <ControlHint label="Закрыть">
            <button
              className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white rounded-full hover:bg-white/5 transition-all text-xl"
              onClick={closeEditModal}
            >
              ×
            </button>
          </ControlHint>
        </div>

        {/* Header with SmartPopover on Name */}
        <div className="mb-6">
          <SmartPopover content={description} isOpen={isHoveringName}>
            <h2 
              className="text-lg font-bold text-white cursor-help inline-block border-b border-transparent hover:border-white/20 transition-all"
              onMouseEnter={() => setIsHoveringName(true)}
              onMouseLeave={() => setIsHoveringName(false)}
            >
              {name || 'Edit Project'}
            </h2>
          </SmartPopover>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">
            Project Instance
          </p>
        </div>

        <div className="flex gap-1 p-1 mb-5 rounded-xl bg-[#111] border border-white/5">
          <button
            type="button"
            className={`flex-1 rounded-lg px-3 py-2 text-xs transition-colors ${section === 'general' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            onClick={() => setSection('general')}
          >
            Основное
          </button>
          <button
            type="button"
            className={`flex-1 rounded-lg px-3 py-2 text-xs transition-colors flex items-center justify-center gap-2 ${section === 'prompts' ? 'bg-violet-500/15 text-violet-200' : 'text-gray-500 hover:text-gray-300'}`}
            onClick={() => setSection('prompts')}
          >
            <MessageSquareQuote size={14} />
            Промпты
          </button>
        </div>

        <div className="overflow-y-auto max-h-[48vh] pr-1">
          {section === 'general' ? (
            <div className="space-y-5">
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1.5 ml-1">Name</label>
                <input
                  type="text"
                  className="w-full bg-[#222] border border-white/5 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-accent focus:bg-[#252525] transition-all"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => handleSave()}
                  placeholder="Enter name..."
                  autoFocus
                />
              </div>

              <div>
                {/* Renamed from "System Path" (2026-08-17): the directory
                    belongs to TABS — each tab carries its own cwd. The project
                    only supplies the default for NEW tabs, and the old name
                    read as the project's identity. */}
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1.5 ml-1 flex items-center gap-2">
                  Директория по умолчанию — для новых вкладок
                  {isPathValid === true && <CheckCircle2 size={12} className="text-green-500" />}
                  {isPathValid === false && <AlertCircle size={12} className="text-red-500" />}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      className={`w-full bg-[#222] border ${isPathValid === false ? 'border-red-500/30' : 'border-white/5'} rounded-xl px-4 py-2 text-white text-[11px] focus:outline-none focus:border-accent transition-all font-mono`}
                      value={path}
                      onChange={(e) => {
                        setPath(e.target.value);
                        setIsPathValid(null);
                      }}
                      onBlur={(e) => {
                        validatePath(e.target.value);
                        handleSave();
                      }}
                      placeholder="/path/to/project"
                    />
                  </div>
                  <button
                    className="w-10 h-10 flex items-center justify-center bg-[#222] hover:bg-[#2a2a2a] text-gray-400 hover:text-white rounded-xl border border-white/5 transition-all cursor-pointer flex-shrink-0"
                    onClick={handleSelectDirectory}
                    title="Выбрать директорию проекта"
                  >
                    <Folder size={18} />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1.5 ml-1">Description</label>
                <textarea
                  className="w-full bg-[#222] border border-white/5 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent focus:bg-[#252525] transition-all resize-none h-28"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => handleSave()}
                  placeholder="What is this project about? Hover the name above to see this description."
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs leading-5 text-gray-400">
                Custom Terminal найдёт все файлы <code className="text-violet-300">docs/**/*.prompt.md</code> внутри указанных директорий. Содержимое остаётся на диске и читается только при вставке.
              </p>

              <div className="flex gap-2">
                <input
                  type="text"
                  className="min-w-0 flex-1 bg-[#222] border border-white/5 rounded-xl px-3 py-2 text-white text-[11px] focus:outline-none focus:border-violet-400/60 transition-all font-mono"
                  value={promptSourceInput}
                  onChange={(event) => setPromptSourceInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void addPromptSource();
                  }}
                  placeholder="/absolute/path/to/source"
                  autoFocus
                />
                <button
                  type="button"
                  className="w-10 h-10 flex items-center justify-center bg-[#222] hover:bg-[#2a2a2a] text-gray-400 hover:text-white rounded-xl border border-white/5 transition-all"
                  onClick={handleSelectPromptDirectory}
                  title="Выбрать папку"
                >
                  <Folder size={17} />
                </button>
                <button
                  type="button"
                  className="w-10 h-10 flex items-center justify-center bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 rounded-xl border border-violet-400/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={!promptSourceInput.trim()}
                  onClick={() => { void addPromptSource(); }}
                  title="Добавить папку"
                >
                  <Plus size={17} />
                </button>
              </div>

              {!promptSourceInput.trim() && path && !path.startsWith('__unset__') && !promptSources.some((source) => source.rootPath === path) && (
                <button
                  type="button"
                  className="text-[11px] text-violet-300 hover:text-violet-200"
                  onClick={() => { void addPromptSource(path); }}
                >
                  + Использовать папку проекта
                </button>
              )}

              <div className="space-y-2">
                {promptSourcesLoading && (
                  <div className="rounded-xl border border-white/5 bg-[#202020] px-3 py-4 text-xs text-gray-500">Загрузка…</div>
                )}
                {!promptSourcesLoading && promptSources.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 bg-[#202020]/60 px-4 py-6 text-center text-xs text-gray-500">
                    Папки проектных промптов ещё не добавлены
                  </div>
                )}
                {!promptSourcesLoading && promptSources.map((source) => (
                  <div key={source.rootPath} className="flex items-center gap-3 rounded-xl border border-white/5 bg-[#202020] px-3 py-2.5">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${source.docsExists ? 'bg-violet-500/15 text-violet-300' : 'bg-amber-500/10 text-amber-300'}`}>
                      {source.docsExists ? <MessageSquareQuote size={16} /> : <AlertCircle size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-gray-200">{source.sourceName || source.rootPath.split('/').pop()}</div>
                      <div className="truncate font-mono text-[9px] text-gray-600" title={source.rootPath}>{source.rootPath}</div>
                      <div className={`mt-1 text-[9px] ${source.docsExists ? 'text-violet-300/80' : 'text-amber-300/80'}`}>
                        {!source.exists ? 'Папка недоступна' : !source.docsExists ? 'docs пока не найден' : `${source.promptCount || 0} промптов`}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                      onClick={() => { void removePromptSource(source.rootPath); }}
                      title="Удалить источник"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <p className="text-[10px] leading-4 text-gray-600">
                Заголовки источников сортируются по алфавиту. Порядок файлов внутри каждого источника следует ручному порядку сайдбара для этого точного корня.
              </p>
            </div>
          )}
        </div>

        <div className="mt-8 pt-4 border-t border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2 text-gray-600">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-glow-green" />
            <span className="text-[10px] uppercase font-bold tracking-tighter">Auto-saving enabled</span>
          </div>
          <span className="text-[10px] text-gray-700 font-mono italic">ESC to close</span>
        </div>
      </div>
    </div>
  );
}
