import React, { useEffect, useState, useRef } from 'react';
import { CircleCheck, AlertTriangle, Loader2 } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface IndexStatus {
  fresh: number;
  stale: number;
  new: number;
  indexExists: boolean;
  docsTotal: number;
  indexedTotal: number;
}

interface ProgressState {
  outdatedTotal: number;
  outdatedCompleted: number;
  currentFile: string;
}

interface SemanticIndexButtonProps {
  // Колбэк для ПКМ — открыть Settings на вкладке «Системные».
  // Хост (ProjectToolbar) знает про SettingsModal lifecycle, кнопка — нет.
  onOpenSettings?: () => void;
}

export default function SemanticIndexButton({ onOpenSettings }: SemanticIndexButtonProps) {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const { showToast } = useUIStore();
  const semanticIndexParallelism = useUIStore((s) => s.semanticIndexParallelism);

  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  // Параллелизм, с которым запущен текущий ребилд. Берётся из rebuild-started
  // payload, не из store — чтобы при mid-rebuild смене настройки чип
  // продолжал показывать реальное N работающих воркеров, а не текущее значение
  // настройки (которое применится к следующему запуску).
  const [runningParallelism, setRunningParallelism] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressState>({ outdatedTotal: 0, outdatedCompleted: 0, currentFile: '' });
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  useEffect(() => {
    // Reset local state immediately on project switch — otherwise the user sees
    // numbers from the previous project for a tick until get-status replies, or
    // a stale running-spinner if a rebuild was active on the project we left.
    // (The rebuild itself keeps running in main; we just stop showing its progress
    // here. If the user switches back, onRebuildStarted/onProgress are filtered by
    // projectId so they will only re-attach if the rebuild belongs to the new project.)
    setStatus(null);
    setIsRunning(false);
    setRunningParallelism(null);
    setProgress({ outdatedTotal: 0, outdatedCompleted: 0, currentFile: '' });

    if (!activeProjectId) return;

    // Request initial status for the new project. Watcher might not be attached yet
    // (App.tsx attaches it via a Zustand subscribe that runs async after invoke).
    // Retry once after a short delay if the first call reports "Not watching".
    // Also restore rebuild state — if rebuild is running on this project (because
    // user switched away earlier and the rebuild kept going in main), we must
    // re-attach the spinner + counter immediately, not wait for the next event.
    const fetchStatus = (retry = true) => {
      ipcRenderer.invoke('semantic-index:get-status', { projectId: activeProjectId })
        .then((r: any) => {
          if (activeProjectIdRef.current !== activeProjectId) return;
          if (r?.success) {
            setStatus(r.status);
            if (r.isRebuilding) {
              setIsRunning(true);
              if (typeof r.rebuildParallelism === 'number') {
                setRunningParallelism(r.rebuildParallelism);
              }
              if (r.rebuildProgress) {
                setProgress({
                  outdatedTotal: r.rebuildProgress.outdatedTotal ?? 0,
                  outdatedCompleted: r.rebuildProgress.outdatedCompleted ?? 0,
                  currentFile: r.rebuildProgress.currentFile ?? '',
                });
              }
            }
          } else if (retry) {
            setTimeout(() => fetchStatus(false), 250);
          }
        })
        .catch(() => {});
    };
    fetchStatus();

    const onStatus = (_e: any, payload: IndexStatus & { projectId: string }) => {
      if (payload.projectId !== activeProjectIdRef.current) return;
      setStatus({
        fresh: payload.fresh,
        stale: payload.stale,
        new: payload.new,
        indexExists: payload.indexExists,
        docsTotal: payload.docsTotal,
        indexedTotal: payload.indexedTotal,
      });
    };

    const onRebuildStarted = (_e: any, payload: { projectId: string; parallelism?: number; outdatedTotal?: number }) => {
      if (payload.projectId !== activeProjectIdRef.current) return;
      setIsRunning(true);
      setRunningParallelism(typeof payload.parallelism === 'number' ? payload.parallelism : null);
      // Seed the total from the start payload so the counter reads `0/3` (real
      // outdated count) immediately, not `…`. main computed it via computeStatus
      // before spawning the script.
      setProgress({ outdatedTotal: payload.outdatedTotal ?? 0, outdatedCompleted: 0, currentFile: '' });
    };

    const onProgress = (_e: any, payload: any) => {
      if (payload.projectId !== activeProjectIdRef.current) return;
      setProgress((prev) => ({
        outdatedTotal: payload.outdatedTotal ?? prev.outdatedTotal,
        outdatedCompleted: payload.outdatedCompleted ?? prev.outdatedCompleted,
        currentFile: payload.file ?? prev.currentFile,
      }));
    };

    const onRebuildDone = (
      _e: any,
      payload: {
        projectId: string;
        success: boolean;
        error?: string;
        stats?: {
          outdatedTotal: number;
          outdatedCompleted: number;
          summaryErrors: number;
          summaryWarnings: number;
          perFileBad: number;
        };
      },
    ) => {
      if (payload.projectId !== activeProjectIdRef.current) return;
      setIsRunning(false);
      setRunningParallelism(null);
      if (payload.success) {
        const s = payload.stats;
        const summary = s ? `Индекс обновлён: ${s.outdatedCompleted}/${s.outdatedTotal} файлов` : 'Индекс обновлён';
        showToast(summary, 'success');
      } else {
        showToast(`Индексация не удалась: ${payload.error || 'unknown'}`, 'error');
      }
    };

    ipcRenderer.on('semantic-index:status', onStatus);
    ipcRenderer.on('semantic-index:rebuild-started', onRebuildStarted);
    ipcRenderer.on('semantic-index:progress', onProgress);
    ipcRenderer.on('semantic-index:rebuild-done', onRebuildDone);

    return () => {
      ipcRenderer.removeListener('semantic-index:status', onStatus);
      ipcRenderer.removeListener('semantic-index:rebuild-started', onRebuildStarted);
      ipcRenderer.removeListener('semantic-index:progress', onProgress);
      ipcRenderer.removeListener('semantic-index:rebuild-done', onRebuildDone);
    };
  }, [activeProjectId, showToast]);

  const handleClick = async () => {
    if (!activeProjectId || isRunning) return;
    const res = await ipcRenderer.invoke('semantic-index:rebuild', {
      projectId: activeProjectId,
      parallelism: semanticIndexParallelism,
    });
    if (!res?.success) {
      showToast(res?.error || 'Не удалось запустить индексацию', 'error');
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    onOpenSettings?.();
  };

  if (!activeProjectId) return null;

  const buttonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '0 12px',
    height: '100%',
    fontSize: '12px',
    color: '#888',
    backgroundColor: 'transparent',
    border: 'none',
    borderTop: '2px solid transparent',
    cursor: isRunning ? 'default' : 'pointer',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
  };

  const handleEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isRunning) return;
    e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
  };
  const handleLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.backgroundColor = 'transparent';
  };

  // === Running state ===
  // Показываем только реально переиндексируемые файлы — кэшированные не считаются
  // (нет смысла показывать "5/90" если 85 из них cached и пролетают мгновенно).
  // Третий параметр — параллелизм (фиолетовый чип), берётся из rebuild-started
  // payload (runningParallelism) и зеркалит реально работающее N воркеров,
  // а не текущее значение Settings.
  if (isRunning) {
    const { outdatedTotal, outdatedCompleted, currentFile } = progress;
    const counter = outdatedTotal > 0 ? `${outdatedCompleted}/${outdatedTotal}` : '…';
    const parallelismLabel = runningParallelism ?? semanticIndexParallelism;
    const tooltipParts = [
      `Переиндексация: ${counter}`,
      `Параллелизм: ${parallelismLabel} (Settings → Системные)`,
    ];
    if (currentFile) tooltipParts.push(currentFile);
    const tooltipText = tooltipParts.join('\n');

    return (
      <Tooltip content={tooltipText}>
        <button onClick={handleClick} onContextMenu={handleContextMenu} style={buttonStyle} disabled>
          <Loader2 size={13} className="animate-spin" style={{ color: '#d97706' }} />
          <span style={{ color: '#d97706' }}>{counter}</span>
          <span style={{ color: '#a855f7', marginLeft: '4px' }}>×{parallelismLabel}</span>
        </button>
      </Tooltip>
    );
  }

  // === Idle state ===
  if (!status) {
    return (
      <button onContextMenu={handleContextMenu} style={{ ...buttonStyle, opacity: 0.4 }} disabled>
        <CircleCheck size={13} />
        <span>—</span>
      </button>
    );
  }

  if (!status.indexExists) {
    return (
      <Tooltip content="Семантический индекс не создан. Клик — собрать индекс через scripts/ai/build-index.sh. ПКМ — настройки.">
        <button
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          style={buttonStyle}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <AlertTriangle size={13} style={{ color: '#d97706' }} />
          <span style={{ color: '#d97706' }}>no index</span>
        </button>
      </Tooltip>
    );
  }

  const outdated = status.stale + status.new;
  const tooltipText =
    `Индекс: ${status.fresh} актуальных, ${status.stale} устаревших, ${status.new} новых\n` +
    `Файлов в docs/: ${status.docsTotal}, записей в индексе: ${status.indexedTotal}\n` +
    (outdated > 0 ? 'Клик — переиндексировать (запуск scripts/ai/build-index.sh в фоне)' : 'Индекс актуален') +
    '\nПКМ — открыть настройки.';

  return (
    <Tooltip content={tooltipText}>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={buttonStyle}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <CircleCheck size={13} style={{ color: '#22c55e' }} />
        <span style={{ color: '#22c55e' }}>{status.fresh}</span>
        {outdated > 0 && (
          <>
            <AlertTriangle size={13} style={{ color: '#d97706', marginLeft: '4px' }} />
            <span style={{ color: '#d97706' }}>{outdated}</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}
