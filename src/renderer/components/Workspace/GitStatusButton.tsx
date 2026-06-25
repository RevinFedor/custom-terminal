import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  FileText,
  GitBranch,
  GripVertical,
  History,
  Home,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Star,
  Upload,
} from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

const DOCS_ONLY_STORAGE_KEY = 'noted-terminal.git.docsOnlyAiContext';
const DEFAULT_PANEL_SIZE = { width: 1040, height: 640 };
const MIN_PANEL_SIZE = { width: 760, height: 420 };
const PANEL_MARGIN = 16;
const MIN_LEFT_PANE_WIDTH = 320;
const MIN_RIGHT_PANE_WIDTH = 380;

type GitFile = {
  path: string;
  oldPath?: string | null;
  rawPath?: string;
  xy: string;
  staged: boolean;
  unstaged: boolean;
  label: string;
};

type GitStatus = {
  success: boolean;
  isRepo: boolean;
  repoRoot: string;
  repoName: string;
  remote: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  changedCount: number;
  hasDocsChanges: boolean;
  error?: string;
};

type GitCommit = {
  hash: string;
  date: string;
  subject: string;
  unpushed?: boolean;
};

type GitCommitDetails = {
  success: boolean;
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  files: GitFile[];
  activeFilePath: string;
  diff: string;
  additions: number;
  deletions: number;
  totalAdditions: number;
  totalDeletions: number;
  truncated?: boolean;
  error?: string;
};

type GitBranchInfo = {
  name: string;
  updated: string;
};

type GitRepository = {
  path: string;
  name: string;
  relativePath: string;
  home: boolean;
};

type GitFileDiff = {
  success: boolean;
  diff: string;
  additions: number;
  deletions: number;
  truncated?: boolean;
  error?: string;
};

type GitPanelPersistedState = {
  open?: boolean;
  panelTab?: 'changes' | 'history';
  summary?: string;
  description?: string;
  search?: string;
  activeFilePath?: string;
  selectedPaths?: string[];
  panelSize?: { width?: number; height?: number };
  splitLeftWidth?: number;
  docsOnlyWhenPresent?: boolean;
  selectedRepoPath?: string;
  repoSelectorTab?: 'repos' | 'favorites';
  repoFavorites?: string[];
  historySearch?: string;
  activeCommitHash?: string;
  activeCommitFilePath?: string;
};

type Props = {
  projectId?: string | null;
  projectName?: string;
  projectPath?: string;
};

function loadDocsOnlySetting() {
  try {
    return window.localStorage.getItem(DOCS_ONLY_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveDocsOnlySetting(value: boolean) {
  try {
    window.localStorage.setItem(DOCS_ONLY_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Local UI preference only.
  }
}

function shortPath(filePath: string) {
  if (filePath.length <= 58) return filePath;
  const parts = filePath.split('/');
  if (parts.length < 3) return '...' + filePath.slice(-55);
  return parts[0] + '/.../' + parts.slice(-2).join('/');
}

function statusColor(xy: string) {
  if (xy === '??') return '#4ade80';
  if (xy.includes('D')) return '#fb7185';
  if (xy.includes('A')) return '#4ade80';
  if (xy.includes('R')) return '#c084fc';
  if (xy.includes('U')) return '#f59e0b';
  return '#facc15';
}

function statusKind(xy: string): 'added' | 'deleted' | 'modified' {
  if (xy === '??' || xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  return 'modified';
}

function normalizePanelSize(size?: { width?: number; height?: number } | null) {
  const maxWidth = Math.max(MIN_PANEL_SIZE.width, window.innerWidth - PANEL_MARGIN * 2);
  const maxHeight = Math.max(MIN_PANEL_SIZE.height, window.innerHeight - PANEL_MARGIN * 2);
  const width = Math.round(Number(size?.width || DEFAULT_PANEL_SIZE.width));
  const height = Math.round(Number(size?.height || DEFAULT_PANEL_SIZE.height));
  return {
    width: Math.max(MIN_PANEL_SIZE.width, Math.min(maxWidth, Number.isFinite(width) ? width : DEFAULT_PANEL_SIZE.width)),
    height: Math.max(MIN_PANEL_SIZE.height, Math.min(maxHeight, Number.isFinite(height) ? height : DEFAULT_PANEL_SIZE.height)),
  };
}

function normalizeSplitLeftWidth(value: number | undefined | null, panelWidth: number) {
  const fallback = Math.round(panelWidth * 0.43);
  const width = Math.round(Number(value || fallback));
  const max = Math.max(MIN_LEFT_PANE_WIDTH, panelWidth - MIN_RIGHT_PANE_WIDTH);
  return Math.max(MIN_LEFT_PANE_WIDTH, Math.min(max, Number.isFinite(width) ? width : fallback));
}

function gitPanelStateKey(projectId?: string | null, repoRoot?: string, projectPath?: string) {
  const raw = projectId || repoRoot || projectPath || '';
  return raw ? 'noted-terminal.git.panel.' + raw : '';
}

function trimError(error: unknown) {
  return String(error || 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function basenameFromPath(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function makeRepository(repoPath: string, projectPath?: string | null, home = false): GitRepository {
  const root = String(projectPath || '').replace(/[\\/]+$/, '');
  const rel = root && repoPath !== root && (repoPath.startsWith(root + '/') || repoPath.startsWith(root + '\\'))
    ? repoPath.slice(root.length + 1)
    : '';
  return {
    path: repoPath,
    name: basenameFromPath(repoPath),
    relativePath: rel || (home ? '' : repoPath),
    home,
  };
}

function makeHomeRepositories(repoPath?: string | null): GitRepository[] {
  const repoPathValue = String(repoPath || '').trim();
  if (!repoPathValue) return [];
  return [makeRepository(repoPathValue, repoPathValue, true)];
}

export default function GitStatusButton({ projectId, projectName, projectPath }: Props) {
  const showToast = useUIStore((state) => state.showToast);
  const activeTabMetaKey = useWorkspaceStore((state) => {
    const activeProjectId = state.activeProjectId;
    if (!activeProjectId) return '';
    const workspace = state.openProjects.get(activeProjectId);
    const tabId = state.getEffectiveTabId();
    const tab = tabId ? workspace?.tabs.get(tabId) : null;
    return `${tabId || ''}\0${tab?.name || ''}`;
  });

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(() => Boolean(projectPath));
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [panelTab, setPanelTab] = useState<'changes' | 'history'>('changes');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docsOnlyWhenPresent, setDocsOnlyWhenPresent] = useState(loadDocsOnlySetting);
  const [search, setSearch] = useState('');
  const [activeFilePath, setActiveFilePath] = useState('');
  const [panelSize, setPanelSize] = useState(() => normalizePanelSize(DEFAULT_PANEL_SIZE));
  const [splitLeftWidth, setSplitLeftWidth] = useState(() => normalizeSplitLeftWidth(undefined, DEFAULT_PANEL_SIZE.width));
  const [selectedRepoPath, setSelectedRepoPath] = useState(projectPath || '');
  const [repoSelectorOpen, setRepoSelectorOpen] = useState(false);
  const [repoSelectorTab, setRepoSelectorTab] = useState<'repos' | 'favorites'>('repos');
  const [repoSearch, setRepoSearch] = useState('');
  const [repositories, setRepositories] = useState<GitRepository[]>(() => makeHomeRepositories(projectPath));
  const [repositoriesProjectPath, setRepositoriesProjectPath] = useState('');
  const [repoFavorites, setRepoFavorites] = useState<string[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repoContextMenu, setRepoContextMenu] = useState<{ x: number; y: number; repo: GitRepository } | null>(null);
  const [dragRepoPath, setDragRepoPath] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState<'push' | 'fetch' | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<GitCommit[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [activeCommitHash, setActiveCommitHash] = useState('');
  const [activeCommitFilePath, setActiveCommitFilePath] = useState('');
  const [commitDetails, setCommitDetails] = useState<GitCommitDetails | null>(null);
  const [commitDetailsLoading, setCommitDetailsLoading] = useState(false);
  const [historyContextMenu, setHistoryContextMenu] = useState<{ x: number; y: number; commit: GitCommit } | null>(null);
  const [undoingCommitHash, setUndoingCommitHash] = useState('');
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchSwitching, setBranchSwitching] = useState('');
  const [pushMenuOpen, setPushMenuOpen] = useState(false);
  const [generationMeta, setGenerationMeta] = useState<any>(null);
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [resizeHover, setResizeHover] = useState<'left' | 'bottom' | 'left-bottom' | null>(null);
  const [splitResizeHover, setSplitResizeHover] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const fsDebounceRef = useRef<number | null>(null);
  const saveDebounceRef = useRef<number | null>(null);
  const statusRequestRef = useRef(0);
  const latestProjectPathRef = useRef(projectPath || '');
  const hydratedStateKeyRef = useRef('');
  const selectionInitializedKeyRef = useRef('');

  const selectedCount = selectedPaths.size;
  const allSelected = status?.files.length ? selectedCount === status.files.length : false;
  const pushLabel = status?.upstream ? 'Push' : 'Publish';
  const [activeTabId, activeTabName] = useMemo(() => {
    const [tabId, tabName] = activeTabMetaKey.split('\0');
    return [tabId || null, tabName || null];
  }, [activeTabMetaKey]);
  const statusFileKey = useMemo(() => status?.files.map((file) => `${file.xy}:${file.path}`).join('\0') || '', [status?.files]);
  const panelStateKey = useMemo(
    () => gitPanelStateKey(projectId, undefined, projectPath),
    [projectId, projectPath]
  );
  const activeFile = useMemo(() => status?.files.find((file) => file.path === activeFilePath) || null, [status?.files, activeFilePath]);
  const filteredFiles = useMemo(() => {
    const files = status?.files || [];
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => `${file.path} ${file.rawPath || ''} ${file.label}`.toLowerCase().includes(q));
  }, [status?.files, search]);
  const filteredHistoryItems = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyItems;
    return historyItems.filter((commit) => `${commit.hash} ${commit.subject} ${commit.date}`.toLowerCase().includes(q));
  }, [historyItems, historySearch]);
  const hydratedForCurrentProject = hydratedStateKeyRef.current === panelStateKey;
  const effectiveRepoPath = (hydratedForCurrentProject ? selectedRepoPath : (projectPath || '')) || projectPath || '';
  const homeRepositories = useMemo(() => makeHomeRepositories(projectPath), [projectPath]);
  const currentRepositories = useMemo(
    () => repositoriesProjectPath === (projectPath || '') ? repositories : homeRepositories,
    [homeRepositories, projectPath, repositories, repositoriesProjectPath]
  );
  const repositoryByPath = useMemo(() => {
    const map = new Map(currentRepositories.map((repo) => [repo.path, repo]));
    for (const repoPath of repoFavorites) {
      if (!map.has(repoPath)) map.set(repoPath, makeRepository(repoPath, projectPath));
    }
    return map;
  }, [currentRepositories, projectPath, repoFavorites]);
  const filteredRepositories = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    const home = currentRepositories.find((repo) => repo.home) || null;
    const matches = (repo: GitRepository) => !q || `${repo.name} ${repo.relativePath} ${repo.path}`.toLowerCase().includes(q);
    const rest = currentRepositories.filter((repo) => !repo.home && matches(repo));
    if (home && matches(home)) return [home, ...rest];
    return rest;
  }, [currentRepositories, repoSearch]);
  const favoriteRepositories = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    return repoFavorites
      .map((repoPath) => repositoryByPath.get(repoPath))
      .filter((repo): repo is GitRepository => !!repo)
      .filter((repo) => !q || `${repo.name} ${repo.relativePath} ${repo.path}`.toLowerCase().includes(q));
  }, [repoFavorites, repositoryByPath, repoSearch]);

  const currentStatusRoot = status?.repoRoot || '';
  const hasCurrentStatus = Boolean(status?.isRepo);

  const loadStatus = useCallback(async (visible = false) => {
    const requestPath = effectiveRepoPath;
    const requestId = ++statusRequestRef.current;
    if (!requestPath) {
      setStatus(null);
      setStatusLoading(false);
      return;
    }
    const showProbe = visible || !hasCurrentStatus || (currentStatusRoot && requestPath !== currentStatusRoot);
    if (showProbe) setStatusLoading(true);
    try {
      const result = await ipcRenderer.invoke('git:status', { projectPath: requestPath });
      if (statusRequestRef.current !== requestId) return;
      if (!result?.success || !result?.isRepo) {
        if (projectPath && requestPath !== projectPath) {
          setSelectedRepoPath(projectPath);
          return;
        }
        setStatus(null);
        return;
      }
      setStatus(result as GitStatus);
      setStatusVersion((value) => value + 1);
    } catch (error: any) {
      if (statusRequestRef.current !== requestId) return;
      if (visible) showToast('Git status: ' + trimError(error?.message || error), 'error');
      setStatus(null);
    } finally {
      if (statusRequestRef.current === requestId && showProbe) setStatusLoading(false);
    }
  }, [currentStatusRoot, effectiveRepoPath, hasCurrentStatus, projectPath, showToast]);

  const loadHistory = useCallback(async () => {
    if (!effectiveRepoPath) return;
    setHistoryLoading(true);
    try {
      const result = await ipcRenderer.invoke('git:history', { projectPath: effectiveRepoPath, limit: 40 });
      if (!result?.success) throw new Error(result?.error || 'git history failed');
      const commits = Array.isArray(result.commits) ? result.commits : [];
      setHistoryItems(commits);
      setActiveCommitHash((prev) => commits.some((commit: GitCommit) => commit.hash === prev) ? prev : (commits[0]?.hash || ''));
    } catch (error: any) {
      showToast('Git history: ' + trimError(error?.message || error), 'error');
    } finally {
      setHistoryLoading(false);
    }
  }, [effectiveRepoPath, showToast]);

  const loadCommitDetails = useCallback(async (commitHash: string, filePath?: string) => {
    if (!effectiveRepoPath || !commitHash) {
      setCommitDetails(null);
      return;
    }
    setCommitDetailsLoading(true);
    try {
      const result = await ipcRenderer.invoke('git:commit-details', {
        projectPath: effectiveRepoPath,
        hash: commitHash,
        filePath: filePath || undefined,
      });
      if (!result?.success) throw new Error(result?.error || 'git commit details failed');
      setCommitDetails(result as GitCommitDetails);
      setActiveCommitFilePath((prev) => {
        const files = Array.isArray(result.files) ? result.files : [];
        if (prev && files.some((file: GitFile) => file.path === prev)) return prev;
        return result.activeFilePath || files[0]?.path || '';
      });
    } catch (error: any) {
      setCommitDetails({ success: false, hash: commitHash, shortHash: commitHash, author: '', date: '', subject: '', files: [], activeFilePath: '', diff: '', additions: 0, deletions: 0, totalAdditions: 0, totalDeletions: 0, error: trimError(error?.message || error) });
    } finally {
      setCommitDetailsLoading(false);
    }
  }, [effectiveRepoPath]);

  const loadBranches = useCallback(async () => {
    if (!effectiveRepoPath) return;
    setBranchesLoading(true);
    try {
      const result = await ipcRenderer.invoke('git:branches', { projectPath: effectiveRepoPath });
      if (!result?.success) throw new Error(result?.error || 'git branches failed');
      setBranches(Array.isArray(result.branches) ? result.branches : []);
    } catch (error: any) {
      showToast('Git branches: ' + trimError(error?.message || error), 'error');
    } finally {
      setBranchesLoading(false);
    }
  }, [effectiveRepoPath, showToast]);

  const loadRepositories = useCallback(async () => {
    const requestProjectPath = projectPath || '';
    if (!requestProjectPath) return;
    setRepositoriesLoading(true);
    try {
      const result = await ipcRenderer.invoke('git:list-repositories', { projectPath: requestProjectPath });
      if (latestProjectPathRef.current !== requestProjectPath) return;
      if (!result?.success) throw new Error(result?.error || 'git repositories failed');
      const list = Array.isArray(result.repositories) ? result.repositories : [];
      setRepositories(list);
      setRepositoriesProjectPath(requestProjectPath);
    } catch (error: any) {
      if (latestProjectPathRef.current !== requestProjectPath) return;
      showToast('Git repos: ' + trimError(error?.message || error), 'error');
    } finally {
      if (latestProjectPathRef.current === requestProjectPath) setRepositoriesLoading(false);
    }
  }, [projectPath, showToast]);

  useEffect(() => {
    const nextProjectPath = projectPath || '';
    latestProjectPathRef.current = nextProjectPath;
    statusRequestRef.current += 1;
    setStatus(null);
    setStatusLoading(Boolean(nextProjectPath));
    setSelectedRepoPath(nextProjectPath);
    setRepositories(makeHomeRepositories(nextProjectPath));
    setRepositoriesProjectPath('');
    setRepositoriesLoading(false);
    setRepoSelectorOpen(false);
    setRepoSearch('');
    setRepoContextMenu(null);
    setDragRepoPath('');
    setBranchesOpen(false);
    setPushMenuOpen(false);
    setHistoryContextMenu(null);
    setUndoingCommitHash('');
    setActiveFilePath('');
    setActiveCommitHash('');
    setActiveCommitFilePath('');
    setCommitDetails(null);
    setFileDiff(null);
    setGenerationMeta(null);
  }, [panelStateKey, projectPath]);

  useEffect(() => {
    loadStatus(false);
  }, [loadStatus]);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      setPos({ top: Math.max(PANEL_MARGIN, r.bottom + 6), right: Math.max(PANEL_MARGIN, window.innerWidth - r.right) });
      setPanelSize((prev) => normalizePanelSize(prev));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!panelStateKey) return;
    let cancelled = false;
    hydratedStateKeyRef.current = '';
    selectionInitializedKeyRef.current = '';
    ipcRenderer.invoke('app:getState', panelStateKey)
      .then((saved: GitPanelPersistedState | null) => {
        if (cancelled) return;
        const next = saved && typeof saved === 'object' ? saved : null;
        setOpen(next?.open === true);
        setPanelTab(next?.panelTab === 'history' ? 'history' : 'changes');
        setSettingsOpen(false);
        setSummary(typeof next?.summary === 'string' ? next.summary : '');
        setDescription(typeof next?.description === 'string' ? next.description : '');
        setSearch(typeof next?.search === 'string' ? next.search : '');
        setHistorySearch(typeof next?.historySearch === 'string' ? next.historySearch : '');
        setActiveFilePath(typeof next?.activeFilePath === 'string' ? next.activeFilePath : '');
        setActiveCommitHash(typeof next?.activeCommitHash === 'string' ? next.activeCommitHash : '');
        setActiveCommitFilePath(typeof next?.activeCommitFilePath === 'string' ? next.activeCommitFilePath : '');
        const nextPanelSize = normalizePanelSize(next?.panelSize);
        setPanelSize(nextPanelSize);
        setSplitLeftWidth(normalizeSplitLeftWidth(next?.splitLeftWidth, nextPanelSize.width));
        setSelectedRepoPath(typeof next?.selectedRepoPath === 'string' && next.selectedRepoPath ? next.selectedRepoPath : (projectPath || ''));
        setRepoSelectorTab(next?.repoSelectorTab === 'favorites' ? 'favorites' : 'repos');
        setRepoFavorites(Array.isArray(next?.repoFavorites) ? next.repoFavorites.filter((item) => typeof item === 'string') : []);
        setRepoSelectorOpen(false);
        setRepoContextMenu(null);
        if (Array.isArray(next?.selectedPaths)) {
          setSelectedPaths(new Set(next.selectedPaths.filter((item) => typeof item === 'string')));
        } else {
          setSelectedPaths(new Set());
        }
        if (typeof next?.docsOnlyWhenPresent === 'boolean') {
          setDocsOnlyWhenPresent(next.docsOnlyWhenPresent);
        } else {
          setDocsOnlyWhenPresent(loadDocsOnlySetting());
        }
        setGenerationMeta(null);
        hydratedStateKeyRef.current = panelStateKey;
      })
      .catch(() => {
        if (!cancelled) hydratedStateKeyRef.current = panelStateKey;
      });
    return () => {
      cancelled = true;
    };
  }, [panelStateKey, projectPath]);

  useEffect(() => {
    if (!panelStateKey || hydratedStateKeyRef.current !== panelStateKey) return;
    if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = window.setTimeout(() => {
      const payload: GitPanelPersistedState = {
        open,
        panelTab,
        summary,
        description,
        search,
        historySearch,
        activeFilePath,
        activeCommitHash,
        activeCommitFilePath,
        selectedPaths: Array.from(selectedPaths),
        panelSize,
        splitLeftWidth,
        docsOnlyWhenPresent,
        selectedRepoPath,
        repoSelectorTab,
        repoFavorites,
      };
      ipcRenderer.invoke('app:setState', { key: panelStateKey, value: payload }).catch(() => {});
    }, 220);
    return () => {
      if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
    };
  }, [panelStateKey, open, panelTab, summary, description, search, historySearch, activeFilePath, activeCommitHash, activeCommitFilePath, selectedPaths, panelSize, splitLeftWidth, docsOnlyWhenPresent, selectedRepoPath, repoSelectorTab, repoFavorites]);

  useEffect(() => {
    if (!open) return;
    loadStatus(true);
  }, [open, loadStatus]);

  useEffect(() => {
    if (panelTab === 'history' && open) loadHistory();
  }, [panelTab, open, loadHistory]);

  useEffect(() => {
    if (!open || panelTab !== 'history' || !activeCommitHash) {
      if (panelTab !== 'history') setCommitDetails(null);
      return;
    }
    loadCommitDetails(activeCommitHash, activeCommitFilePath);
  }, [open, panelTab, activeCommitHash, activeCommitFilePath, loadCommitDetails]);

  useEffect(() => {
    if (branchesOpen) loadBranches();
  }, [branchesOpen, loadBranches]);

  useEffect(() => {
    if (repoSelectorOpen && projectPath && repositoriesProjectPath !== projectPath) loadRepositories();
  }, [repoSelectorOpen, projectPath, repositoriesProjectPath, loadRepositories]);

  useEffect(() => {
    const files = status?.files || [];
    const allowed = new Set(files.map((file) => file.path));
    if (!files.length) {
      setSelectedPaths(new Set());
      setActiveFilePath('');
      setFileDiff(null);
      setGenerationMeta(null);
      return;
    }

    const selectionKey = `${panelStateKey || 'default'}\0${status?.repoRoot || effectiveRepoPath}`;
    setSelectedPaths((prev) => {
      const filtered = Array.from(prev).filter((filePath) => allowed.has(filePath));
      if (selectionInitializedKeyRef.current !== selectionKey) {
        selectionInitializedKeyRef.current = selectionKey;
        return new Set(filtered.length ? filtered : files.map((file) => file.path));
      }
      return new Set(filtered);
    });
    setActiveFilePath((prev) => allowed.has(prev) ? prev : files[0].path);
    setGenerationMeta(null);
  }, [statusFileKey, panelStateKey, status?.files, status?.repoRoot, effectiveRepoPath]);

  useEffect(() => {
    if (!open || panelTab !== 'changes' || !effectiveRepoPath || !activeFilePath) {
      setFileDiff(null);
      setFileDiffLoading(false);
      return;
    }
    let cancelled = false;
    let started = false;
    setFileDiffLoading(true);
    const timer = window.setTimeout(() => {
      started = true;
      ipcRenderer.invoke('git:file-diff', { projectPath: effectiveRepoPath, filePath: activeFilePath })
        .then((result: GitFileDiff) => {
          if (cancelled) return;
          if (!result?.success) throw new Error(result?.error || 'git diff failed');
          setFileDiff(result);
        })
        .catch((error: any) => {
          if (!cancelled) setFileDiff({ success: false, diff: '', additions: 0, deletions: 0, error: trimError(error?.message || error) });
        })
        .finally(() => {
          if (!cancelled) setFileDiffLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      if (!started) {
        window.clearTimeout(timer);
        setFileDiffLoading(false);
      }
    };
  }, [open, panelTab, effectiveRepoPath, activeFilePath, statusFileKey, statusVersion]);

  useEffect(() => {
    const onFocus = () => loadStatus(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadStatus]);

  useEffect(() => {
    const onFsChange = (_event: any, payload: any) => {
      if (!status?.repoRoot || !payload?.path || !String(payload.path).startsWith(status.repoRoot)) return;
      if (fsDebounceRef.current) window.clearTimeout(fsDebounceRef.current);
      fsDebounceRef.current = window.setTimeout(() => loadStatus(false), 350);
    };
    ipcRenderer.on('fs:change', onFsChange);
    return () => {
      ipcRenderer.removeListener('fs:change', onFsChange);
      if (fsDebounceRef.current) window.clearTimeout(fsDebounceRef.current);
    };
  }, [loadStatus, status?.repoRoot]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false);
        else setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, settingsOpen]);

  const selectedList = useMemo(() => Array.from(selectedPaths), [selectedPaths]);

  const toggleDocsOnly = () => {
    const next = !docsOnlyWhenPresent;
    setDocsOnlyWhenPresent(next);
    saveDocsOnlySetting(next);
  };

  const togglePath = (filePath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleAll = () => {
    if (!status) return;
    setSelectedPaths(allSelected ? new Set() : new Set(status.files.map((file) => file.path)));
  };

  const selectRepository = (repoPath: string) => {
    if (!repoPath) return;
    setSelectedRepoPath(repoPath);
    setRepoSelectorOpen(false);
    setRepoContextMenu(null);
    setHistoryContextMenu(null);
    setBranchesOpen(false);
    setPushMenuOpen(false);
    setActiveFilePath('');
    setActiveCommitHash('');
    setActiveCommitFilePath('');
    setCommitDetails(null);
    setHistoryItems([]);
    setSelectedPaths(new Set());
    setSummary('');
    setDescription('');
    setGenerationMeta(null);
  };

  const addRepoFavorite = (repoPath: string) => {
    if (!repoPath) return;
    setRepoFavorites((prev) => prev.includes(repoPath) ? prev : [...prev, repoPath]);
    setRepoContextMenu(null);
  };

  const addRepositoryToProject = async () => {
    try {
      const selectedPath = await ipcRenderer.invoke('app:select-directory');
      if (!selectedPath) return;
      const result = await ipcRenderer.invoke('git:status', { projectPath: selectedPath });
      if (!result?.success || !result?.isRepo || !result.repoRoot) {
        showToast('Selected folder is not a Git repository', 'warning');
        return;
      }
      addRepoFavorite(result.repoRoot);
      setRepoSelectorTab('favorites');
      setRepoSearch('');
    } catch (error: any) {
      showToast('Add repository: ' + trimError(error?.message || error), 'error');
    }
  };

  const removeRepoFavorite = (repoPath: string) => {
    setRepoFavorites((prev) => prev.filter((item) => item !== repoPath));
    setRepoContextMenu(null);
  };

  const moveFavoriteRepo = (sourcePath: string, targetPath: string) => {
    if (!sourcePath || !targetPath || sourcePath === targetPath) return;
    setRepoFavorites((prev) => {
      const without = prev.filter((item) => item !== sourcePath);
      const targetIndex = without.indexOf(targetPath);
      if (targetIndex === -1) return prev;
      const next = [...without];
      next.splice(targetIndex, 0, sourcePath);
      return next;
    });
  };

  const startPanelResize = (edge: 'left' | 'bottom' | 'left-bottom', event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = panelSize;
    const oldCursor = document.body.style.cursor;
    const oldUserSelect = document.body.style.userSelect;
    document.body.style.cursor = edge === 'left' ? 'ew-resize' : edge === 'bottom' ? 'ns-resize' : 'nesw-resize';
    document.body.style.userSelect = 'none';
    const onMove = (moveEvent: MouseEvent) => {
      const next = {
        width: edge === 'left' || edge === 'left-bottom' ? startSize.width + (startX - moveEvent.clientX) : startSize.width,
        height: edge === 'bottom' || edge === 'left-bottom' ? startSize.height + (moveEvent.clientY - startY) : startSize.height,
      };
      setPanelSize(normalizePanelSize(next));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldUserSelect;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const startSplitResize = (event: React.MouseEvent, panelWidth: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = normalizeSplitLeftWidth(splitLeftWidth, panelWidth);
    const oldCursor = document.body.style.cursor;
    const oldUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    const onMove = (moveEvent: MouseEvent) => {
      setSplitLeftWidth(normalizeSplitLeftWidth(startWidth + (moveEvent.clientX - startX), panelWidth));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldUserSelect;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const showGithubAuthToast = (error: string) => {
    showToast(
      'GitHub не принял доступ',
      'pink',
      0,
      true,
      error,
      'GitHub Desktop',
      async () => {
        const result = await ipcRenderer.invoke('git:open-github-desktop', { projectPath: effectiveRepoPath });
        if (!result?.success) showToast('GitHub Desktop: ' + trimError(result?.error), 'error');
      },
      undefined,
      'github-desktop'
    );
  };

  const handleGenerate = async () => {
    if (!effectiveRepoPath || !status) return;
    if (!selectedList.length) {
      showToast('Select files for commit message', 'warning');
      return;
    }
    setGenerating(true);
    setGenerationMeta(null);
    try {
      const result = await ipcRenderer.invoke('git:generate-commit-message', {
        projectPath: effectiveRepoPath,
        selectedPaths: selectedList,
        docsOnlyWhenPresent,
        projectId,
        projectName,
        tabId: activeTabId,
        tabName: activeTabName,
      });
      if (!result?.success) throw new Error(result?.error || 'AI commit message failed');
      setSummary(result.message.summary || '');
      setDescription(result.message.description || '');
      setGenerationMeta(result.meta || null);
      showToast('Commit description generated', 'success');
    } catch (error: any) {
      showToast('Commit AI: ' + trimError(error?.message || error), 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleCommit = async () => {
    if (!effectiveRepoPath) return;
    if (!selectedList.length) {
      showToast('Select files to commit', 'warning');
      return;
    }
    if (!summary.trim()) {
      showToast('Summary is required', 'warning');
      return;
    }
    setCommitting(true);
    try {
      const result = await ipcRenderer.invoke('git:commit', {
        projectPath: effectiveRepoPath,
        selectedPaths: selectedList,
        summary,
        description,
      });
      if (!result?.success) throw new Error(result?.error || 'git commit failed');
      showToast(result.hash ? 'Committed ' + result.hash : 'Committed', 'success');
      setSummary('');
      setDescription('');
      await loadStatus(true);
      if (panelTab === 'history') await loadHistory();
    } catch (error: any) {
      showToast('Commit: ' + trimError(error?.message || error), 'error', 5000);
    } finally {
      setCommitting(false);
    }
  };

  const handleUndoCommit = async (commit: GitCommit) => {
    if (!effectiveRepoPath || !commit?.hash) return;
    if (historyItems[0]?.hash !== commit.hash) {
      showToast('Only the latest commit can be undone', 'warning');
      return;
    }
    setUndoingCommitHash(commit.hash);
    setHistoryContextMenu(null);
    try {
      const result = await ipcRenderer.invoke('git:undo-last-commit', {
        projectPath: effectiveRepoPath,
        hash: commit.hash,
      });
      if (!result?.success) throw new Error(result?.error || 'git undo failed');
      showToast('Commit undone', 'success');
      setActiveCommitHash('');
      setActiveCommitFilePath('');
      setCommitDetails(null);
      await loadStatus(true);
      await loadHistory();
    } catch (error: any) {
      showToast('Undo commit: ' + trimError(error?.message || error), 'error', 5000);
    } finally {
      setUndoingCommitHash('');
    }
  };

  const handleRemote = async (type: 'push' | 'fetch') => {
    if (!effectiveRepoPath) return;
    setRemoteBusy(type);
    setPushMenuOpen(false);
    try {
      const result = await ipcRenderer.invoke(type === 'push' ? 'git:push' : 'git:fetch', { projectPath: effectiveRepoPath });
      if (!result?.success) {
        const error = result?.error || (type === 'push' ? 'git push failed' : 'git fetch failed');
        if (result?.authError) showGithubAuthToast(error);
        else showToast((type === 'push' ? 'Push: ' : 'Fetch: ') + trimError(error), 'error', 5000, false, String(error));
        return;
      }
      showToast(type === 'push' ? 'Pushed' : 'Fetched origin', 'success');
      await loadStatus(true);
      if (panelTab === 'history') await loadHistory();
    } catch (error: any) {
      showToast((type === 'push' ? 'Push: ' : 'Fetch: ') + trimError(error?.message || error), 'error');
    } finally {
      setRemoteBusy(null);
    }
  };

  const handleBranchCheckout = async (branch: string) => {
    if (!effectiveRepoPath || branch === status?.branch) {
      setBranchesOpen(false);
      return;
    }
    setBranchSwitching(branch);
    try {
      const result = await ipcRenderer.invoke('git:checkout', { projectPath: effectiveRepoPath, branch });
      if (!result?.success) throw new Error(result?.error || 'git checkout failed');
      showToast('Branch: ' + branch, 'success');
      setBranchesOpen(false);
      await loadStatus(true);
      if (panelTab === 'history') await loadHistory();
    } catch (error: any) {
      showToast('Checkout: ' + trimError(error?.message || error), 'error', 5000);
    } finally {
      setBranchSwitching('');
    }
  };

  if (!status?.isRepo) {
    if (projectPath && (statusLoading || hydratedStateKeyRef.current !== panelStateKey)) {
      return (
        <button
          disabled
          title="Checking Git repository"
          className="inline-flex items-center gap-1 rounded transition-colors"
          style={{
            height: 26,
            padding: '0 9px',
            fontSize: 11,
            color: '#9ca3af',
            backgroundColor: 'transparent',
            border: '1px solid rgba(255,255,255,0.10)',
            maxWidth: 156,
            cursor: 'default',
          }}
        >
          <Loader2 size={12} className="animate-spin" />
          <span style={{ fontWeight: 700 }}>Git</span>
        </button>
      );
    }
    return null;
  }

  const compactText = status.changedCount > 0 ? String(status.changedCount) : 'clean';
  const remoteHint = status.ahead || status.behind
    ? ` · ${status.ahead ? 'ahead ' + status.ahead : ''}${status.ahead && status.behind ? ', ' : ''}${status.behind ? 'behind ' + status.behind : ''}`
    : '';
  const renderedPanelSize = pos
    ? {
      width: Math.max(MIN_PANEL_SIZE.width, Math.min(panelSize.width, window.innerWidth - pos.right - PANEL_MARGIN)),
      height: Math.max(MIN_PANEL_SIZE.height, Math.min(panelSize.height, window.innerHeight - pos.top - PANEL_MARGIN)),
    }
    : panelSize;
  const renderedSplitLeftWidth = normalizeSplitLeftWidth(splitLeftWidth, renderedPanelSize.width);
  const remoteTitle = remoteBusy === 'fetch'
    ? 'Fetching'
    : remoteBusy === 'push'
      ? 'Pushing'
      : pushLabel + ' branch';
  const remoteSubtitle = remoteBusy === 'fetch'
    ? 'Fetching latest changes'
    : remoteBusy === 'push'
      ? (status.upstream ? 'Pushing to origin' : 'Publishing branch')
      : (status.upstream ? 'Push changes to origin' : 'Publish this branch to ...');

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        title={`${status.repoName}: ${status.branch} · ${status.changedCount} changed${remoteHint}`}
        className="inline-flex items-center gap-1 rounded cursor-pointer hover:opacity-90 transition-colors"
        style={{
          height: 26,
          padding: '0 9px',
          fontSize: 11,
          color: open ? '#fff' : '#cbd5e1',
          backgroundColor: open ? 'rgba(56,189,248,0.12)' : 'transparent',
          border: '1px solid ' + (open ? 'rgba(56,189,248,0.35)' : 'rgba(255,255,255,0.10)'),
          maxWidth: 156,
        }}
      >
        <GitBranch size={12} />
        <span style={{ maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>
          {status.branch}
        </span>
        <span
          style={{
            minWidth: 28,
            height: 16,
            padding: '0 5px',
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: status.changedCount ? 'rgba(250,204,21,0.16)' : 'rgba(34,197,94,0.14)',
            color: status.changedCount ? '#fde68a' : '#86efac',
            fontSize: 10,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {compactText}
        </span>
      </button>

      {open && pos && createPortal(
        <>
          <div
            onMouseDown={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'transparent' }}
          />
          <div
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'fixed',
              top: pos.top,
              right: pos.right,
              zIndex: 9999,
              width: renderedPanelSize.width,
              height: renderedPanelSize.height,
              overflow: 'hidden',
              backgroundColor: '#181a1f',
              border: '1px solid #373b44',
              borderRadius: 8,
              boxShadow: '0 14px 38px rgba(0,0,0,0.62)',
              color: '#e5e7eb',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              onMouseDown={(event) => startPanelResize('left', event)}
              onMouseEnter={() => setResizeHover('left')}
              onMouseLeave={() => setResizeHover(null)}
              title="Resize"
              style={leftResizeHandleStyle(resizeHover === 'left')}
            />
            <div
              onMouseDown={(event) => startPanelResize('bottom', event)}
              onMouseEnter={() => setResizeHover('bottom')}
              onMouseLeave={() => setResizeHover(null)}
              title="Resize"
              style={bottomResizeHandleStyle(resizeHover === 'bottom')}
            />
            <div
              onMouseDown={(event) => startPanelResize('left-bottom', event)}
              onMouseEnter={() => setResizeHover('left-bottom')}
              onMouseLeave={() => setResizeHover(null)}
              title="Resize"
              style={leftBottomResizeHandleStyle(resizeHover === 'left-bottom')}
            />
            {settingsOpen ? (
              <SettingsView
                docsOnlyWhenPresent={docsOnlyWhenPresent}
                onBack={() => setSettingsOpen(false)}
                onToggleDocsOnly={toggleDocsOnly}
              />
            ) : (
              <div
                style={{
                  ...gitPanelGridStyle,
                  gridTemplateColumns: `${renderedSplitLeftWidth}px minmax(0, 1fr)`,
                }}
                onMouseDown={() => {
                  setHistoryContextMenu(null);
                  setRepoContextMenu(null);
                }}
              >
                <div
                  onMouseDown={(event) => startSplitResize(event, renderedPanelSize.width)}
                  onMouseEnter={() => setSplitResizeHover(true)}
                  onMouseLeave={() => setSplitResizeHover(false)}
                  title="Resize columns"
                  style={splitResizeHandleStyle(renderedSplitLeftWidth, splitResizeHover)}
                />
                <div style={gitHeaderLeftStyle}>
                  <div style={{ minWidth: 0, flex: 1, position: 'relative' }}>
                    <button
                      onClick={() => {
                        const willOpen = !repoSelectorOpen;
                        setRepoSelectorOpen(willOpen);
                        setRepoContextMenu(null);
                        if (willOpen && projectPath && repositoriesProjectPath !== projectPath) loadRepositories();
                      }}
                      style={repoSelectButtonStyle}
                      title={status.repoRoot}
                    >
                      <FileText size={14} style={{ flexShrink: 0, color: '#cbd5e1' }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 10, color: '#8b949e', fontWeight: 760, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                          Current Repository
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: '#f8fafc', fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1, textAlign: 'left' }}>
                          {status.repoName}
                        </span>
                      </span>
                      <ChevronDown size={13} style={{ flexShrink: 0, color: '#9ca3af', transform: repoSelectorOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }} />
                    </button>
                    {repoSelectorOpen && (
                      <RepositoryMenu
                        repositories={filteredRepositories}
                        favorites={favoriteRepositories}
                        favoritePaths={repoFavorites}
                        activePath={status.repoRoot}
                        tab={repoSelectorTab}
                        search={repoSearch}
                        loading={repositoriesLoading}
                        contextMenu={repoContextMenu}
                        dragRepoPath={dragRepoPath}
                        onTabChange={setRepoSelectorTab}
                        onSearchChange={setRepoSearch}
                        onSelect={selectRepository}
                        onContextMenu={setRepoContextMenu}
                        onAddFavorite={addRepoFavorite}
                        onRemoveFavorite={removeRepoFavorite}
                        onRefresh={loadRepositories}
                        onAddRepository={addRepositoryToProject}
                        onDragPathChange={setDragRepoPath}
                        onMoveFavorite={moveFavoriteRepo}
                      />
                    )}
                  </div>
                </div>

                <div style={gitHeaderRightStyle}>
                  <div style={{ position: 'relative', minWidth: 0, flex: 1 }}>
                    <button
                      onClick={() => setBranchesOpen((value) => !value)}
                      style={branchHeaderButtonStyle}
                    >
                      <GitBranch size={14} style={{ flexShrink: 0 }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 10, color: '#8b949e', fontWeight: 760, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                          Current Branch
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: '#f8fafc', fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1, textAlign: 'left' }}>
                          {status.branch}
                        </span>
                      </span>
                      <ChevronDown size={13} style={{ transform: branchesOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }} />
                    </button>
                    {branchesOpen && (
                      <div style={branchMenuStyle}>
                        {branchesLoading ? (
                          <div style={emptyLineStyle}><Loader2 size={13} className="animate-spin" /> Loading branches</div>
                        ) : branches.length ? branches.map((branch) => (
                          <button
                            key={branch.name}
                            onClick={() => handleBranchCheckout(branch.name)}
                            style={branchRowStyle(branch.name === status.branch)}
                          >
                            <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center' }}>
                              {branch.name === status.branch ? <Check size={13} /> : branchSwitching === branch.name ? <Loader2 size={13} className="animate-spin" /> : null}
                            </span>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {branch.name}
                            </span>
                            {branch.updated && <span style={{ color: '#7d8590', fontSize: 10 }}>{branch.updated}</span>}
                          </button>
                        )) : (
                          <div style={emptyLineStyle}>No branches</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'inline-flex', position: 'relative', height: '100%' }}>
                    <button
                      onClick={() => handleRemote('push')}
                      disabled={remoteBusy !== null}
                      style={{ ...remoteHeaderButtonStyle, borderTopRightRadius: 0, borderBottomRightRadius: 0, minWidth: 154 }}
                    >
                      {remoteBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                      <span style={{ minWidth: 0, textAlign: 'left' }}>
                        <span style={{ display: 'block', fontSize: 12, fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {remoteTitle}
                        </span>
                        <span style={{ display: 'block', fontSize: 10, color: '#8b949e', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {remoteSubtitle}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={() => setPushMenuOpen((value) => !value)}
                      disabled={remoteBusy !== null}
                      title="More remote actions"
                      style={{ ...remoteHeaderButtonStyle, borderLeft: '1px solid rgba(255,255,255,0.10)', borderTopLeftRadius: 0, borderBottomLeftRadius: 0, width: 36, padding: 0 }}
                    >
                      <ChevronDown size={13} style={{ transform: pushMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }} />
                    </button>
                    {pushMenuOpen && (
                      <div style={remoteMenuStyle}>
                        <button onClick={() => handleRemote('fetch')} style={remoteMenuItemStyle}>
                          {remoteBusy === 'fetch' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          Fetch origin
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div style={gitTabsLeftStyle}>
                  <TabButton active={panelTab === 'changes'} onClick={() => {
                    setBranchesOpen(false);
                    setPushMenuOpen(false);
                    setHistoryContextMenu(null);
                    setPanelTab('changes');
                  }}>
                    Changes
                    <span style={countPillStyle}>{status.changedCount}</span>
                  </TabButton>
                  <TabButton active={panelTab === 'history'} onClick={() => {
                    setBranchesOpen(false);
                    setPushMenuOpen(false);
                    setHistoryContextMenu(null);
                    setPanelTab('history');
                  }}>
                    History
                  </TabButton>
                </div>

                <div style={gitRightToolbarStyle}>
                  <div style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 800, color: '#f8fafc' }}>
                    {panelTab === 'changes' ? (activeFile?.path || 'No file selected') : (commitDetails?.subject || 'Select a commit')}
                  </div>
                  <button
                    onClick={async () => {
                      await loadStatus(true);
                      if (panelTab === 'history') await loadHistory();
                    }}
                    disabled={statusLoading || historyLoading}
                    title="Refresh"
                    style={iconButtonStyle}
                  >
                    <RefreshCw size={13} className={statusLoading || historyLoading ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => setSettingsOpen(true)} title="Git settings" style={iconButtonStyle}>
                    <Settings size={13} />
                  </button>
                </div>

                <div style={gitLeftBodyStyle}>
                {panelTab === 'changes' ? (
                  <div style={changesSidebarStyle}>
                      <div style={searchBoxStyle}>
                        <Search size={13} style={{ color: '#7d8590', flexShrink: 0 }} />
                        <input
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                          placeholder="Search files"
                          style={searchInputStyle}
                        />
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9, marginBottom: 8 }}>
                        <button onClick={toggleAll} style={selectAllStyle}>
                          <span style={checkboxStyle(allSelected)}>{allSelected ? <Check size={11} /> : null}</span>
                          {selectedCount}/{status.changedCount} selected
                        </button>
                        {status.ahead || status.behind ? (
                          <span style={{ fontSize: 10, color: '#8b949e' }}>{remoteHint.replace(/^ · /, '')}</span>
                        ) : null}
                      </div>

                      <div style={fileListStyle}>
                        {filteredFiles.length ? filteredFiles.map((file) => {
                          const checked = selectedPaths.has(file.path);
                          const active = file.path === activeFilePath;
                          return (
                            <button
                              key={`${file.xy}:${file.path}`}
                              onClick={() => setActiveFilePath(file.path)}
                              style={fileRowStyle(checked, active)}
                              title={file.rawPath || file.path}
                            >
                              <span
                                onClick={(event) => {
                                  event.stopPropagation();
                                  togglePath(file.path);
                                }}
                                style={checkboxStyle(checked)}
                              >
                                {checked ? <Check size={11} /> : null}
                              </span>
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                                {shortPath(file.path)}
                              </span>
                              <StatusGlyph file={file} />
                            </button>
                          );
                        }) : (
                          <div style={{ padding: 18, color: '#8b949e', fontSize: 12, textAlign: 'center' }}>
                            {status.files.length ? 'No files match search' : 'Working tree clean'}
                          </div>
                        )}
                      </div>

                      {generationMeta?.docsOnlyApplied && (
                        <div style={{ marginTop: 8, fontSize: 10, color: '#93c5fd' }}>
                          AI context: docs changes only
                        </div>
                      )}
                      {generationMeta?.truncated && (
                        <div style={{ marginTop: 6, fontSize: 10, color: '#fbbf24' }}>
                          AI context was truncated
                        </div>
                      )}

                      <div style={commitFormStyle}>
                        <input
                          value={summary}
                          onChange={(event) => setSummary(event.target.value)}
                          placeholder="Summary (required)"
                          style={inputStyle}
                        />
                        <textarea
                          value={description}
                          onChange={(event) => setDescription(event.target.value)}
                          placeholder="Description"
                          style={{ ...inputStyle, height: 72, resize: 'vertical', paddingTop: 8 }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            onClick={handleGenerate}
                            disabled={generating || committing || selectedCount === 0 || status.changedCount === 0}
                            style={secondaryButtonStyle(generating || committing || selectedCount === 0 || status.changedCount === 0)}
                          >
                            {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                            {generating ? 'Generating' : 'Generate'}
                          </button>
                          <button
                            onClick={handleCommit}
                            disabled={committing || selectedCount === 0 || !summary.trim()}
                            style={{ ...primaryButtonStyle, flex: 1, opacity: committing || selectedCount === 0 || !summary.trim() ? 0.55 : 1 }}
                          >
                            {committing ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                            {committing ? 'Committing' : `Commit ${selectedCount || ''}`.trim()}
                          </button>
                        </div>
                      </div>
                  </div>
                ) : (
                  <div style={historyPaneStyle}>
                    <div style={searchBoxStyle}>
                      <Search size={13} style={{ color: '#7d8590', flexShrink: 0 }} />
                      <input
                        value={historySearch}
                        onChange={(event) => setHistorySearch(event.target.value)}
                        placeholder="Search history"
                        style={searchInputStyle}
                      />
                    </div>
                    <div style={historyListStyle}>
                      {historyLoading ? (
                        <div style={emptyStateStyle}><Loader2 size={15} className="animate-spin" /> Loading history</div>
                      ) : filteredHistoryItems.length ? filteredHistoryItems.map((commit) => (
                        <button
                          key={commit.hash}
                          onClick={() => {
                            setActiveCommitHash(commit.hash);
                            setActiveCommitFilePath('');
                            setHistoryContextMenu(null);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setActiveCommitHash(commit.hash);
                            setActiveCommitFilePath('');
                            setHistoryContextMenu({ x: event.clientX, y: event.clientY, commit });
                          }}
                          style={historyRowStyle(commit.hash === activeCommitHash)}
                        >
                          <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 800, color: '#f1f5f9' }}>{commit.subject}</span>
                            <span style={{ display: 'block', color: '#8b949e', fontSize: 10.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {commit.hash} · {commit.date}
                            </span>
                          </span>
                          {undoingCommitHash === commit.hash ? (
                            <span style={historyPushBadgeStyle} title="Undoing commit">
                              <Loader2 size={13} className="animate-spin" />
                            </span>
                          ) : commit.unpushed ? (
                            <span style={historyPushBadgeStyle} title="Not pushed">
                              <Upload size={13} />
                            </span>
                          ) : null}
                        </button>
                      )) : (
                        <div style={emptyStateStyle}>{historyItems.length ? 'No commits match search' : 'No commits yet'}</div>
                      )}
                    </div>
                    {historyContextMenu && (
                      <HistoryCommitContextMenu
                        x={historyContextMenu.x}
                        y={historyContextMenu.y}
                        canUndo={historyItems[0]?.hash === historyContextMenu.commit.hash}
                        undoing={undoingCommitHash === historyContextMenu.commit.hash}
                        onUndo={() => handleUndoCommit(historyContextMenu.commit)}
                      />
                    )}
                  </div>
                )}
                </div>
                <div style={gitRightBodyStyle}>
                  {panelTab === 'changes' ? (
                    <DiffPreview
                      file={activeFile}
                      diff={fileDiff}
                      loading={fileDiffLoading}
                    />
                  ) : (
                    <HistoryCommitPreview
                      details={commitDetails}
                      loading={commitDetailsLoading}
                      activeFilePath={activeCommitFilePath}
                      onSelectFile={setActiveCommitFilePath}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 28,
        flex: 1,
        border: 'none',
        borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
        background: active ? 'rgba(59,130,246,0.08)' : 'transparent',
        color: active ? '#f8fafc' : '#8b949e',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        fontSize: 11.5,
        fontWeight: 750,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function RepositoryMenu({
  repositories,
  favorites,
  favoritePaths,
  activePath,
  tab,
  search,
  loading,
  contextMenu,
  dragRepoPath,
  onTabChange,
  onSearchChange,
  onSelect,
  onContextMenu,
  onAddFavorite,
  onRemoveFavorite,
  onRefresh,
  onAddRepository,
  onDragPathChange,
  onMoveFavorite,
}: {
  repositories: GitRepository[];
  favorites: GitRepository[];
  favoritePaths: string[];
  activePath: string;
  tab: 'repos' | 'favorites';
  search: string;
  loading: boolean;
  contextMenu: { x: number; y: number; repo: GitRepository } | null;
  dragRepoPath: string;
  onTabChange: (tab: 'repos' | 'favorites') => void;
  onSearchChange: (value: string) => void;
  onSelect: (repoPath: string) => void;
  onContextMenu: (menu: { x: number; y: number; repo: GitRepository } | null) => void;
  onAddFavorite: (repoPath: string) => void;
  onRemoveFavorite: (repoPath: string) => void;
  onRefresh: () => void;
  onAddRepository: () => void;
  onDragPathChange: (repoPath: string) => void;
  onMoveFavorite: (sourcePath: string, targetPath: string) => void;
}) {
  const rows = tab === 'favorites' ? favorites : repositories;
  return (
    <>
      <div style={repoMenuStyle} onMouseDown={(event) => event.stopPropagation()}>
        <div style={repoTabsStyle}>
          <RepoTabButton active={tab === 'repos'} onClick={() => onTabChange('repos')}>
            <GitBranch size={12} />
            Repos
          </RepoTabButton>
          <RepoTabButton active={tab === 'favorites'} onClick={() => onTabChange('favorites')}>
            <Star size={12} />
            This Project
          </RepoTabButton>
        </div>
        <div style={repoSearchStyle}>
          <Search size={12} style={{ color: '#7d8590', flexShrink: 0 }} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search repositories"
            style={repoSearchInputStyle}
            autoFocus
          />
        </div>
        <div style={repoActionBarStyle}>
          <button onClick={onRefresh} disabled={loading} style={repoActionButtonStyle(loading)}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Update
          </button>
          <button onClick={onAddRepository} style={repoActionButtonStyle(false)}>
            <Plus size={12} />
            Add
          </button>
        </div>

        <div style={repoListStyle}>
          {rows.length ? rows.map((repo) => (
            <button
              key={repo.path}
              onClick={() => onSelect(repo.path)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu({ x: event.clientX, y: event.clientY, repo });
              }}
              draggable={tab === 'favorites'}
              onDragStart={(event) => {
                if (tab !== 'favorites') return;
                onDragPathChange(repo.path);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', repo.path);
              }}
              onDragOver={(event) => {
                if (tab !== 'favorites' || !dragRepoPath || dragRepoPath === repo.path) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                onMoveFavorite(dragRepoPath || event.dataTransfer.getData('text/plain'), repo.path);
                onDragPathChange('');
              }}
              onDragEnd={() => onDragPathChange('')}
              style={repoRowStyle(repo.path === activePath, dragRepoPath === repo.path)}
              title={repo.path}
            >
              <span style={repoIconSlotStyle}>
                {repo.home ? <Home size={13} /> : repo.path === activePath ? <Check size={13} /> : null}
              </span>
              <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 760, color: '#f1f5f9' }}>
                  {repo.name}
                </span>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: '#7d8590', marginTop: 1 }}>
                  {repo.relativePath || repo.path}
                </span>
              </span>
              {favoritePaths.includes(repo.path) && tab !== 'favorites' ? <Star size={12} style={{ color: '#facc15', flexShrink: 0 }} /> : null}
              {tab === 'favorites' ? <GripVertical size={14} style={{ color: '#6b7280', flexShrink: 0, cursor: 'grab' }} /> : null}
            </button>
          )) : null}
          {loading ? (
            <div style={emptyLineStyle}><Loader2 size={13} className="animate-spin" /> Loading repositories</div>
          ) : !rows.length ? (
            <div style={emptyLineStyle}>{tab === 'favorites' ? 'No favorites for this project' : 'No repositories'}</div>
          ) : null}
        </div>
      </div>

      {contextMenu && (
        <div
          style={{ ...repoContextMenuStyle, left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {favoritePaths.includes(contextMenu.repo.path) ? (
            <button onClick={() => onRemoveFavorite(contextMenu.repo.path)} style={repoContextMenuItemStyle}>
              <Star size={12} />
              Remove favorite
            </button>
          ) : (
            <button onClick={() => onAddFavorite(contextMenu.repo.path)} style={repoContextMenuItemStyle}>
              <Star size={12} />
              Add favorite
            </button>
          )}
        </div>
      )}
    </>
  );
}

function HistoryCommitContextMenu({
  x,
  y,
  canUndo,
  undoing,
  onUndo,
}: {
  x: number;
  y: number;
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
}) {
  const disabled = !canUndo || undoing;
  return (
    <div
      style={{ ...historyContextMenuStyle, left: x, top: y }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        onClick={onUndo}
        disabled={disabled}
        title={canUndo ? 'Undo latest commit' : 'Only the latest commit can be undone'}
        style={historyContextMenuItemStyle(disabled)}
      >
        {undoing ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        Undo Commit
      </button>
    </div>
  );
}

function RepoTabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26,
        flex: 1,
        border: 'none',
        borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
        background: active ? 'rgba(59,130,246,0.10)' : 'transparent',
        color: active ? '#f8fafc' : '#9ca3af',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 800,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function SettingsView({
  docsOnlyWhenPresent,
  onBack,
  onToggleDocsOnly,
}: {
  docsOnlyWhenPresent: boolean;
  onBack: () => void;
  onToggleDocsOnly: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 280 }}>
      <div style={{ height: 46, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <button onClick={onBack} title="Back" style={iconButtonStyle}>
          <ArrowLeft size={14} />
        </button>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#f8fafc' }}>Git settings</div>
      </div>
      <div style={{ padding: 12 }}>
        <button
          onClick={onToggleDocsOnly}
          style={{
            width: '100%',
            minHeight: 58,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(255,255,255,0.04)',
            color: '#e5e7eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 11px',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, fontWeight: 750, color: '#f8fafc' }}>Docs-only AI context</span>
            <span style={{ display: 'block', fontSize: 10.5, color: '#8b949e', marginTop: 3, lineHeight: 1.35 }}>
              When docs changed, Generate sends only changed docs files.
            </span>
          </span>
          <span
            role="switch"
            aria-checked={docsOnlyWhenPresent}
            style={{
              width: 36,
              height: 20,
              borderRadius: 999,
              background: docsOnlyWhenPresent ? '#2563eb' : 'rgba(255,255,255,0.14)',
              position: 'relative',
              flexShrink: 0,
              transition: 'background 120ms ease',
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: '#fff',
                position: 'absolute',
                top: 2,
                left: docsOnlyWhenPresent ? 18 : 2,
                transition: 'left 120ms ease',
              }}
            />
          </span>
        </button>
      </div>
    </div>
  );
}

function StatusGlyph({ file }: { file: GitFile }) {
  const kind = statusKind(file.xy);
  const color = statusColor(file.xy);
  const icon = kind === 'added'
    ? <Plus size={12} strokeWidth={3} />
    : kind === 'deleted'
      ? <Minus size={12} strokeWidth={3} />
      : <Circle size={8} fill="currentColor" strokeWidth={0} />;
  return (
    <span
      title={file.label}
      style={{
        width: 17,
        height: 17,
        borderRadius: 4,
        border: '1px solid ' + color,
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: 'rgba(0,0,0,0.16)',
      }}
    >
      {icon}
    </span>
  );
}

type RenderedDiffLine = {
  key: string;
  type: 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'empty';
  oldNo: string;
  newNo: string;
  marker: string;
  text: string;
};

function renderDiffLines(diffText: string): RenderedDiffLine[] {
  const out: RenderedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  const hunkRegex = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
  String(diffText || '').split(/\r?\n/).forEach((line, index) => {
    const hunk = line.match(hunkRegex);
    if (hunk) {
      oldLine = Number(hunk[1]) || 0;
      newLine = Number(hunk[2]) || 0;
      out.push({ key: `${index}:h`, type: 'hunk', oldNo: '', newNo: '', marker: '@@', text: line });
      return;
    }
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index') || line.startsWith('rename from') || line.startsWith('rename to') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      out.push({ key: `${index}:m`, type: 'meta', oldNo: '', newNo: '', marker: '', text: line });
      return;
    }
    if (line.startsWith('+')) {
      out.push({ key: `${index}:a`, type: 'add', oldNo: '', newNo: String(newLine || ''), marker: '+', text: line.slice(1) });
      newLine += 1;
      return;
    }
    if (line.startsWith('-')) {
      out.push({ key: `${index}:d`, type: 'del', oldNo: String(oldLine || ''), newNo: '', marker: '-', text: line.slice(1) });
      oldLine += 1;
      return;
    }
    if (!line) {
      out.push({ key: `${index}:e`, type: 'empty', oldNo: oldLine ? String(oldLine) : '', newNo: newLine ? String(newLine) : '', marker: ' ', text: '' });
      if (oldLine || newLine) {
        oldLine += 1;
        newLine += 1;
      }
      return;
    }
    out.push({ key: `${index}:c`, type: 'context', oldNo: oldLine ? String(oldLine) : '', newNo: newLine ? String(newLine) : '', marker: ' ', text: line.startsWith(' ') ? line.slice(1) : line });
    if (oldLine || newLine) {
      oldLine += 1;
      newLine += 1;
    }
  });
  return out;
}

function DiffPreview({
  file,
  diff,
  loading,
}: {
  file: GitFile | null;
  diff: GitFileDiff | null;
  loading: boolean;
}) {
  const lines = useMemo(() => renderDiffLines(diff?.diff || ''), [diff?.diff]);
  return (
    <div style={diffPaneStyle}>
      <div style={diffHeaderStyle}>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          {file && <StatusGlyph file={file} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 760, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file ? file.label || statusKind(file.xy) : 'Diff preview'}
            </div>
          {file?.oldPath && (
            <div style={{ fontSize: 10, color: '#8b949e', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              renamed from {file.oldPath}
            </div>
          )}
          </div>
        </div>
        {diff && diff.success !== false && (
          <div style={diffStatStyle}>
            <span style={{ color: '#86efac' }}>+{diff.additions || 0}</span>
            <span style={{ color: '#fda4af' }}>-{diff.deletions || 0}</span>
          </div>
        )}
      </div>

      <div style={diffBodyStyle}>
        {!file ? (
          <div style={emptyStateStyle}>Select a file to preview changes</div>
        ) : loading ? (
          <div style={emptyStateStyle}><Loader2 size={15} className="animate-spin" /> Loading diff</div>
        ) : diff?.error ? (
          <div style={emptyStateStyle}>Diff error: {diff.error}</div>
        ) : lines.length ? (
          <div style={{ minWidth: 'max-content' }}>
            {lines.map((line) => (
              <div key={line.key} style={diffLineStyle(line.type)}>
                <span style={lineNoStyle}>{line.oldNo}</span>
                <span style={lineNoStyle}>{line.newNo}</span>
                <span style={diffMarkerStyle(line.type)}>{line.marker}</span>
                <span style={diffTextStyle(line.type)}>{line.text || ' '}</span>
              </div>
            ))}
            {diff?.truncated && (
              <div style={{ color: '#fbbf24', padding: '8px 12px', fontSize: 11 }}>Diff truncated</div>
            )}
          </div>
        ) : (
          <div style={emptyStateStyle}>No textual diff</div>
        )}
      </div>
    </div>
  );
}

function HistoryCommitPreview({
  details,
  loading,
  activeFilePath,
  onSelectFile,
}: {
  details: GitCommitDetails | null;
  loading: boolean;
  activeFilePath: string;
  onSelectFile: (filePath: string) => void;
}) {
  const activeFile = details?.files.find((file) => file.path === activeFilePath) || details?.files[0] || null;
  const diff = details ? {
    success: details.success,
    diff: details.diff,
    additions: details.additions,
    deletions: details.deletions,
    truncated: details.truncated,
    error: details.error,
  } : null;

  if (loading && !details) {
    return (
      <div style={historyDetailShellStyle}>
        <div style={emptyStateStyle}><Loader2 size={15} className="animate-spin" /> Loading commit</div>
      </div>
    );
  }

  if (!details) {
    return (
      <div style={historyDetailShellStyle}>
        <div style={emptyStateStyle}>Select a commit to preview files</div>
      </div>
    );
  }

  if (details.error) {
    return (
      <div style={historyDetailShellStyle}>
        <div style={emptyStateStyle}>Commit error: {details.error}</div>
      </div>
    );
  }

  return (
    <div style={historyDetailShellStyle}>
      <div style={historyDetailHeaderStyle}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ color: '#f8fafc', fontSize: 12, fontWeight: 820, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {details.author || 'Unknown author'}
            </span>
            <span style={{ color: '#8b949e', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', flexShrink: 0 }}>
              {details.shortHash}
            </span>
          </div>
          <div style={{ marginTop: 4, color: '#8b949e', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {details.date}
          </div>
        </div>
        <div style={diffStatStyle}>
          <span style={{ color: '#86efac' }}>+{details.totalAdditions || 0}</span>
          <span style={{ color: '#fda4af' }}>-{details.totalDeletions || 0}</span>
        </div>
      </div>

      <div style={historyDetailBodyStyle}>
        <div style={commitFilesPaneStyle}>
          <div style={commitFilesHeaderStyle}>{details.files.length} changed files</div>
          <div style={{ minHeight: 0, overflowY: 'auto' }}>
            {details.files.map((file) => (
              <button
                key={`${details.shortHash}:${file.path}`}
                onClick={() => onSelectFile(file.path)}
                style={commitFileRowStyle(file.path === activeFile?.path)}
                title={file.rawPath || file.path}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                  {shortPath(file.path)}
                </span>
                <StatusGlyph file={file} />
              </button>
            ))}
          </div>
        </div>
        <DiffPreview file={activeFile} diff={diff} loading={loading} />
      </div>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  color: '#cbd5e1',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 7,
  background: '#111318',
  color: '#f8fafc',
  outline: 'none',
  padding: '0 9px',
  height: 34,
  fontSize: 12,
  lineHeight: 1.35,
};

const repoSelectButtonStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  height: '100%',
  border: 'none',
  background: 'transparent',
  color: '#e5e7eb',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '0 18px',
  cursor: 'pointer',
};

const repoMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 40,
  left: 0,
  width: 380,
  maxWidth: 'calc(100vw - 48px)',
  zIndex: 5,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#111318',
  boxShadow: '0 16px 34px rgba(0,0,0,0.58)',
  overflow: 'hidden',
};

const repoTabsStyle: React.CSSProperties = {
  display: 'flex',
  height: 28,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
};

const repoSearchStyle: React.CSSProperties = {
  height: 30,
  margin: 6,
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 8px',
};

const repoSearchInputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: '#f8fafc',
  fontSize: 11.5,
};

const repoActionBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 6px 6px',
};

const repoActionButtonStyle = (disabled: boolean): React.CSSProperties => ({
  height: 24,
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.035)',
  color: disabled ? '#6b7280' : '#cbd5e1',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  padding: '0 8px',
  fontSize: 10.5,
  fontWeight: 760,
  cursor: disabled ? 'default' : 'pointer',
});

const repoListStyle: React.CSSProperties = {
  maxHeight: 252,
  overflowY: 'auto',
  padding: '0 4px 5px',
};

const repoIconSlotStyle: React.CSSProperties = {
  width: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#d1d5db',
  flexShrink: 0,
};

const repoRowStyle = (active: boolean, dragging: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: 34,
  border: 'none',
  borderRadius: 6,
  background: active ? 'rgba(59,130,246,0.16)' : dragging ? 'rgba(255,255,255,0.08)' : 'transparent',
  color: '#d1d5db',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '4px 7px',
  cursor: 'pointer',
});

const repoContextMenuStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 10002,
  minWidth: 138,
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#111318',
  boxShadow: '0 10px 24px rgba(0,0,0,0.55)',
  padding: 4,
};

const repoContextMenuItemStyle: React.CSSProperties = {
  width: '100%',
  height: 26,
  borderRadius: 5,
  border: 'none',
  background: 'transparent',
  color: '#e5e7eb',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 7px',
  fontSize: 11,
  fontWeight: 750,
  cursor: 'pointer',
  textAlign: 'left',
};

const historyContextMenuStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 10002,
  minWidth: 142,
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#111318',
  boxShadow: '0 10px 24px rgba(0,0,0,0.55)',
  padding: 4,
};

const historyContextMenuItemStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  height: 26,
  borderRadius: 5,
  border: 'none',
  background: 'transparent',
  color: disabled ? '#6b7280' : '#e5e7eb',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 7px',
  fontSize: 11,
  fontWeight: 750,
  cursor: disabled ? 'default' : 'pointer',
  textAlign: 'left',
});

const leftResizeHandleStyle = (active: boolean): React.CSSProperties => ({
  position: 'absolute',
  left: -3,
  top: 0,
  bottom: 0,
  width: 8,
  cursor: 'ew-resize',
  zIndex: 100,
  background: active ? 'rgba(96,165,250,0.24)' : 'rgba(96,165,250,0.01)',
  transition: 'background 100ms ease',
});

const bottomResizeHandleStyle = (active: boolean): React.CSSProperties => ({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: -3,
  height: 8,
  cursor: 'ns-resize',
  zIndex: 100,
  background: active ? 'rgba(96,165,250,0.24)' : 'rgba(96,165,250,0.01)',
  transition: 'background 100ms ease',
});

const leftBottomResizeHandleStyle = (active: boolean): React.CSSProperties => ({
  position: 'absolute',
  left: 0,
  bottom: 0,
  width: 18,
  height: 18,
  cursor: 'nesw-resize',
  zIndex: 101,
  borderLeft: active ? '2px solid rgba(96,165,250,0.75)' : '2px solid transparent',
  borderBottom: active ? '2px solid rgba(96,165,250,0.75)' : '2px solid transparent',
  background: active ? 'rgba(96,165,250,0.08)' : 'rgba(96,165,250,0.01)',
  borderBottomLeftRadius: 7,
  transition: 'border-color 100ms ease',
});

const splitResizeHandleStyle = (leftWidth: number, active: boolean): React.CSSProperties => ({
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: leftWidth - 4,
  width: 8,
  zIndex: 20,
  cursor: 'ew-resize',
  background: active ? 'rgba(96,165,250,0.24)' : 'rgba(96,165,250,0.01)',
  borderLeft: active ? '1px solid rgba(96,165,250,0.72)' : '1px solid transparent',
  borderRight: active ? '1px solid rgba(96,165,250,0.38)' : '1px solid transparent',
  transition: 'background 100ms ease, border-color 100ms ease',
});

const gitPanelGridStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(380px, 43%) minmax(0, 1fr)',
  gridTemplateRows: '52px 30px minmax(0, 1fr)',
  overflow: 'hidden',
  position: 'relative',
};

const gitHeaderLeftStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  alignItems: 'stretch',
  borderRight: '1px solid rgba(255,255,255,0.08)',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#15181d',
};

const gitHeaderRightStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  alignItems: 'stretch',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#15181d',
};

const gitTabsLeftStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  borderRight: '1px solid rgba(255,255,255,0.08)',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#1b2027',
};

const gitRightToolbarStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 10px 0 14px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#1b2027',
};

const gitLeftBodyStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  borderRight: '1px solid rgba(255,255,255,0.08)',
};

const gitRightBodyStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
};

const branchHeaderButtonStyle: React.CSSProperties = {
  height: '100%',
  width: '100%',
  border: 'none',
  borderRight: '1px solid rgba(255,255,255,0.08)',
  background: 'transparent',
  color: '#f8fafc',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 9,
  padding: '0 13px',
  cursor: 'pointer',
  minWidth: 0,
};

const remoteHeaderButtonStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 0,
  border: 'none',
  background: 'transparent',
  color: '#f8fafc',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 9,
  padding: '0 13px',
  fontSize: 11.5,
  fontWeight: 800,
  cursor: 'pointer',
};

const changesSidebarStyle: React.CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  padding: 12,
  overflow: 'hidden',
};

const searchBoxStyle: React.CSSProperties = {
  height: 30,
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#111318',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 9px',
};

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: '#f8fafc',
  fontSize: 12,
};

const fileListStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 92,
  overflowY: 'auto',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 7,
};

const commitFormStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flexShrink: 0,
};

const historyPaneStyle: React.CSSProperties = {
  height: '100%',
  minHeight: 0,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const historyListStyle: React.CSSProperties = {
  marginTop: 8,
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 7,
  overflowY: 'auto',
  minHeight: 0,
  flex: 1,
};

const diffPaneStyle: React.CSSProperties = {
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: '#101216',
};

const diffHeaderStyle: React.CSSProperties = {
  height: 34,
  flexShrink: 0,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
};

const diffStatStyle: React.CSSProperties = {
  height: 22,
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 800,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  flexShrink: 0,
};

const diffBodyStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto',
  overscrollBehavior: 'contain',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 11.5,
  lineHeight: '18px',
  background: '#0d1117',
};

const lineNoStyle: React.CSSProperties = {
  width: 38,
  flexShrink: 0,
  textAlign: 'right',
  paddingRight: 8,
  color: '#6e7681',
  userSelect: 'none',
  borderRight: '1px solid rgba(255,255,255,0.06)',
};

const diffMarkerStyle = (type: RenderedDiffLine['type']): React.CSSProperties => ({
  width: 22,
  flexShrink: 0,
  textAlign: 'center',
  color: type === 'add' ? '#7ee787' : type === 'del' ? '#ffa198' : type === 'hunk' ? '#79c0ff' : '#6e7681',
  userSelect: 'none',
});

const diffTextStyle = (type: RenderedDiffLine['type']): React.CSSProperties => ({
  display: 'inline-block',
  whiteSpace: 'pre',
  width: 'max-content',
  color: type === 'meta' ? '#8b949e' : type === 'hunk' ? '#79c0ff' : type === 'add' ? '#d2f8d2' : type === 'del' ? '#ffd7d7' : '#c9d1d9',
  paddingRight: 12,
  flexShrink: 0,
});

const diffLineStyle = (type: RenderedDiffLine['type']): React.CSSProperties => ({
  minHeight: 18,
  minWidth: '100%',
  width: 'max-content',
  display: 'flex',
  alignItems: 'stretch',
  background:
    type === 'add' ? 'rgba(46,160,67,0.22)' :
    type === 'del' ? 'rgba(248,81,73,0.22)' :
    type === 'hunk' ? 'rgba(56,139,253,0.12)' :
    type === 'meta' ? 'rgba(255,255,255,0.025)' :
    'transparent',
});

const primaryButtonStyle: React.CSSProperties = {
  height: 30,
  borderRadius: 7,
  border: '1px solid rgba(59,130,246,0.45)',
  background: 'rgba(37,99,235,0.84)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0 11px',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
};

const secondaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  height: 30,
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.05)',
  color: '#dbeafe',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0 11px',
  fontSize: 12,
  fontWeight: 750,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.55 : 1,
});

const countPillStyle: React.CSSProperties = {
  minWidth: 18,
  height: 16,
  padding: '0 5px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.10)',
  color: '#cbd5e1',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  fontVariantNumeric: 'tabular-nums',
};

const selectAllStyle: React.CSSProperties = {
  height: 24,
  border: 'none',
  background: 'transparent',
  color: '#cbd5e1',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  padding: 0,
};

const checkboxStyle = (checked: boolean): React.CSSProperties => ({
  width: 15,
  height: 15,
  borderRadius: 4,
  border: '1px solid ' + (checked ? '#60a5fa' : 'rgba(255,255,255,0.18)'),
  background: checked ? 'rgba(37,99,235,0.85)' : 'rgba(255,255,255,0.04)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

const fileRowStyle = (checked: boolean, active: boolean): React.CSSProperties => ({
  width: '100%',
  height: 32,
  border: 'none',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  background: active ? 'rgba(59,130,246,0.16)' : checked ? 'rgba(59,130,246,0.07)' : 'transparent',
  color: '#d1d5db',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 9px',
  cursor: 'pointer',
  fontSize: 11.5,
});

const emptyStateStyle: React.CSSProperties = {
  minHeight: 180,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  color: '#8b949e',
  fontSize: 12,
};

const historyRowStyle = (active: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: 48,
  border: 'none',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  background: active ? 'rgba(59,130,246,0.72)' : 'transparent',
  color: '#d1d5db',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '7px 10px',
  cursor: 'pointer',
});

const historyPushBadgeStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 999,
  background: 'rgba(148,163,184,0.28)',
  color: '#f8fafc',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const historyDetailShellStyle: React.CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: '#101216',
};

const historyDetailHeaderStyle: React.CSSProperties = {
  minHeight: 46,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#141820',
};

const historyDetailBodyStyle: React.CSSProperties = {
  minHeight: 0,
  flex: 1,
  display: 'grid',
  gridTemplateColumns: 'minmax(210px, 34%) minmax(0, 1fr)',
  overflow: 'hidden',
};

const commitFilesPaneStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid rgba(255,255,255,0.08)',
  background: '#171b22',
};

const commitFilesHeaderStyle: React.CSSProperties = {
  height: 36,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  color: '#cbd5e1',
  fontSize: 12,
  fontWeight: 800,
};

const commitFileRowStyle = (active: boolean): React.CSSProperties => ({
  width: '100%',
  height: 32,
  border: 'none',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  background: active ? 'rgba(59,130,246,0.16)' : 'transparent',
  color: '#d1d5db',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 9px',
  cursor: 'pointer',
  fontSize: 11.5,
});

const branchMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  width: 340,
  maxWidth: 'min(340px, calc(100vw - 32px))',
  zIndex: 6,
  maxHeight: 220,
  overflowY: 'auto',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#111318',
  boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
  padding: 4,
};

const branchRowStyle = (active: boolean): React.CSSProperties => ({
  width: '100%',
  height: 30,
  borderRadius: 6,
  border: 'none',
  background: active ? 'rgba(59,130,246,0.14)' : 'transparent',
  color: active ? '#bfdbfe' : '#d1d5db',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 7px',
  fontSize: 11,
  fontWeight: active ? 800 : 650,
  cursor: 'pointer',
});

const emptyLineStyle: React.CSSProperties = {
  height: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  color: '#8b949e',
  padding: '0 8px',
  fontSize: 11,
};

const remoteMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  right: 0,
  zIndex: 6,
  minWidth: 142,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#111318',
  boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
  padding: 4,
};

const remoteMenuItemStyle: React.CSSProperties = {
  width: '100%',
  height: 30,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: '#d1d5db',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
};
