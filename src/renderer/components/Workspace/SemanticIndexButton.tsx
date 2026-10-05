import React, { useEffect, useState, useRef } from 'react';
import { CircleCheck, AlertTriangle, Loader2 } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { showSemanticIndexFailureToast } from '../../utils/semanticIndexFailureToast.mjs';

const { ipcRenderer } = window.require('electron');

interface IndexStatus {
  fresh: number;
  stale: number;
  new: number;
  removed: number;
  indexExists: boolean;
  docsTotal: number;
  indexedTotal: number;
}

interface ProgressState {
  outdatedTotal: number;
  outdatedCompleted: number;
  currentFile: string;
  activeWorkers: number;
  workerLimit: number | null;
}

interface SemanticIndexButtonProps {
  // Колбэк для ПКМ — открыть Settings на вкладке «Системные».
  // Хост (SidebarToolsRow) знает про SettingsModal lifecycle, кнопка — нет.
  onOpenSettings?: () => void;
  // Кнопка живёт в узком ряду инструментов боковой панели, где её обычные
  // отступы в 12px съели бы место двух соседей. Смысл и состояния те же —
  // меняется только коробка: рамка вместо полной высоты полосы.
  compact?: boolean;
}

export default function SemanticIndexButton({ onOpenSettings, compact = false }: SemanticIndexButtonProps) {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const { showToast } = useUIStore();
  const semanticIndexParallelism = useUIStore((s) => s.semanticIndexParallelism);

  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  // Live worker chip for the current rebuild. Seeded from rebuild-started and
  // then updated by MCP progress, so a settings change mid-run does not rewrite
  // the visible state of an already running indexer.
  const [runningParallelism, setRunningParallelism] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressState>({
    outdatedTotal: 0,
    outdatedCompleted: 0,
    currentFile: '',
    activeWorkers: 0,
    workerLimit: null,
  });
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
    setProgress({ outdatedTotal: 0, outdatedCompleted: 0, currentFile: '', activeWorkers: 0, workerLimit: null });

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
                  activeWorkers: r.rebuildProgress.activeWorkers ?? 0,
                  workerLimit: r.rebuildProgress.workerLimit ?? null,
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
        removed: payload.removed || 0,
        indexExists: payload.indexExists,
        docsTotal: payload.docsTotal,
        indexedTotal: payload.indexedTotal,
      });
    };

    const onRebuildStarted = (_e: any, payload: {
      projectId: string;
      parallelism?: number;
      workerLimit?: number;
      outdatedTotal?: number;
    }) => {
      if (payload.projectId !== activeProjectIdRef.current) return;
      setIsRunning(true);
      setRunningParallelism(typeof payload.parallelism === 'number' ? payload.parallelism : null);
      // Seed the total from the start payload so the counter reads `0/3` (real
      // outdated count) immediately, not `…`. main computed it via computeStatus
      // before spawning the script.
      setProgress({
        outdatedTotal: payload.outdatedTotal ?? 0,
        outdatedCompleted: 0,
        currentFile: '',
        activeWorkers: 0,
        workerLimit: payload.workerLimit ?? null,
      });
    };

    const onProgress = (_e: any, payload: any) => {
      if (payload.projectId !== activeProjectIdRef.current) return;
      if (typeof payload.parallelism === 'number') {
        setRunningParallelism(payload.parallelism);
      }
      setProgress((prev) => ({
        outdatedTotal: payload.outdatedTotal ?? prev.outdatedTotal,
        outdatedCompleted: payload.outdatedCompleted ?? prev.outdatedCompleted,
        currentFile: payload.file ?? prev.currentFile,
        activeWorkers: payload.activeWorkers ?? prev.activeWorkers,
        workerLimit: payload.workerLimit ?? prev.workerLimit,
      }));
    };

    const onRebuildDone = (
      _e: any,
      payload: {
        projectId: string;
        success: boolean;
        error?: string;
        projectPath?: string;
        provider?: string;
        model?: string;
        stats?: {
          sawSummary?: boolean;
          outdatedTotal: number;
          outdatedCompleted: number;
          summaryErrors: number;
          summaryWarnings: number;
          perFileBad: number;
          failedFiles?: string[];
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
        showSemanticIndexFailureToast(showToast, payload);
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
    try {
      const res = await ipcRenderer.invoke('semantic-index:rebuild', {
        projectId: activeProjectId,
        parallelism: semanticIndexParallelism,
      });
      if (!res?.success) {
        showSemanticIndexFailureToast(showToast, { ...res, projectId: activeProjectId });
      }
    } catch (error) {
      showSemanticIndexFailureToast(showToast, {
        projectId: activeProjectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    onOpenSettings?.();
  };

  if (!activeProjectId) return null;

  const idleBackground = compact ? 'rgba(255,255,255,0.035)' : 'transparent';
  const buttonStyle: React.CSSProperties = compact
    ? {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      padding: '0 6px',
      height: 26,
      minWidth: 26,
      flexShrink: 0,
      borderRadius: 5,
      fontSize: 11,
      fontWeight: 600,
      color: '#8a8a90',
      backgroundColor: idleBackground,
      border: '1px solid rgba(255,255,255,0.10)',
      cursor: isRunning ? 'default' : 'pointer',
      outline: 'none',
      fontVariantNumeric: 'tabular-nums',
    }
    : {
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

  const iconSize = 13;

  const handleEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isRunning) return;
    e.currentTarget.style.backgroundColor = compact ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.05)';
  };
  const handleLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.backgroundColor = idleBackground;
  };

  // === Running state ===
  // Показываем только реально переиндексируемые файлы — кэшированные не считаются
  // (нет смысла показывать "5/90" если 85 из них cached и пролетают мгновенно).
  // Третий параметр — live worker chip. На scan-фазе он остаётся ×1; если MCP
  // реально запускает несколько Codex-процессов одновременно, progress поднимет
  // его до ×2/×3.
  if (isRunning) {
    const { outdatedTotal, outdatedCompleted, currentFile, activeWorkers, workerLimit } = progress;
    const counter = outdatedTotal > 0 ? `${outdatedCompleted}/${outdatedTotal}` : '…';
    const parallelismLabel = runningParallelism ?? semanticIndexParallelism;
    const tooltipParts = [
      `Переиндексация: ${counter}`,
      workerLimit
        ? `Воркеры: ${activeWorkers}/${workerLimit} (лимит из Settings)`
        : `Параллелизм: ${parallelismLabel} (Settings → Системные)`,
    ];
    if (currentFile) tooltipParts.push(currentFile);
    const tooltipText = tooltipParts.join('\n');

    return (
      <Tooltip content={tooltipText}>
        <button onClick={handleClick} onContextMenu={handleContextMenu} style={buttonStyle} disabled>
          <Loader2 size={iconSize} className="animate-spin" style={{ color: '#d97706' }} />
          <span style={{ color: '#d97706' }}>{counter}</span>
          {/* Число одновременных воркеров — отладочная подробность. В узком ряду
              она вытесняет соседние кнопки, а тот же счёт есть в подсказке. */}
          {!compact && (
            <span style={{ color: '#a855f7', marginLeft: '4px' }}>×{parallelismLabel}</span>
          )}
        </button>
      </Tooltip>
    );
  }

  // === Idle state ===
  if (!status) {
    return (
      <button onContextMenu={handleContextMenu} style={{ ...buttonStyle, opacity: 0.4 }} disabled>
        <CircleCheck size={iconSize} />
        <span>—</span>
      </button>
    );
  }

  if (!status.indexExists) {
    return (
      <Tooltip content="Семантический индекс не создан. Клик — собрать индекс через Codex. ПКМ — настройки.">
        <button
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          style={buttonStyle}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <AlertTriangle size={iconSize} style={{ color: '#d97706' }} />
          {/* «Индекса нет» — состояние, а не число. В узком ряду его несёт
              сам янтарный значок, подпись есть в подсказке. */}
          {!compact && <span style={{ color: '#d97706' }}>no index</span>}
        </button>
      </Tooltip>
    );
  }

  const removed = status.removed || 0;
  const outdated = status.stale + status.new + removed;
  const tooltipText =
    `Индекс: ${status.fresh} актуальных, ${status.stale} устаревших, ${status.new} новых, ${removed} удалённых\n` +
    `Файлов в docs/: ${status.docsTotal}, записей в индексе: ${status.indexedTotal}\n` +
    (outdated > 0 ? 'Клик — переиндексировать через Codex в фоне' : 'Индекс актуален') +
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
        <CircleCheck size={iconSize} style={{ color: '#22c55e' }} />
        {/* В узком ряду число актуальных файлов не показываем: «всё в порядке»
            и так сказано зелёным значком. Отставание — другое дело, это
            единственное число, ради которого сюда смотрят. */}
        {!compact && <span style={{ color: '#22c55e' }}>{status.fresh}</span>}
        {outdated > 0 && (
          <>
            <AlertTriangle size={iconSize} style={{ color: '#d97706', marginLeft: compact ? 0 : '4px' }} />
            <span style={{ color: '#d97706' }}>{outdated}</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}
