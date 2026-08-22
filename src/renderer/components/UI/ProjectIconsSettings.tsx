import React, { useEffect, useRef, useState } from 'react';
import {
  Crop,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import IconCropper from '../Workspace/IconCropper.jsx';
import { isInboxProjectId } from '../../constants/systemProjects';

type ProjectIconProject = {
  id: string;
  name: string;
  path: string;
  icon?: string | null;
};

type IconTarget =
  | { kind: 'workflow'; id: string }
  | { kind: 'project'; id: string };

type FileRequest = {
  target: IconTarget;
  mode: 'open' | 'replace';
};

type StatusMessage = {
  tone: 'working' | 'success' | 'error';
  text: string;
};

const WORKFLOW_FALLBACK_COLORS = [
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#ca8a04',
  '#ea580c',
  '#db2777',
];

const headerActionStyle: React.CSSProperties = {
  height: '26px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px',
  padding: '0 9px',
  borderRadius: '6px',
  border: '1px solid #353535',
  background: '#242424',
  color: '#d6d6d6',
  fontSize: '11px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

function targetKey(target: IconTarget) {
  return `${target.kind}:${target.id}`;
}

function sameTarget(left: IconTarget | null, right: IconTarget | null) {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id);
}

function workflowFallbackColor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return WORKFLOW_FALLBACK_COLORS[Math.abs(hash) % WORKFLOW_FALLBACK_COLORS.length];
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader returned no data URL'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

function IconActionButton({
  title,
  onClick,
  disabled = false,
  busy = false,
  danger = false,
  size = 26,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  size?: number;
  children: React.ReactNode;
}) {
  const isDisabled = disabled || busy;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-busy={busy || undefined}
      disabled={isDisabled}
      onClick={onClick}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        flex: `0 0 ${size}px`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        borderRadius: size <= 20 ? '5px' : '6px',
        border: '1px solid #353535',
        background: '#242424',
        color: danger ? '#f87171' : '#aeb0b5',
        opacity: isDisabled ? 0.38 : 1,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
      }}
    >
      {busy ? <Loader2 size={Math.max(11, size - 10)} className="animate-spin" /> : children}
    </button>
  );
}

function WorkflowNameEditor({
  id,
  name,
  focusOnMount,
  onCommit,
  onFocused,
}: {
  id: string;
  name: string;
  focusOnMount: boolean;
  onCommit: (id: string, name: string) => void;
  onFocused: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(name);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(name);
  }, [name]);

  useEffect(() => {
    if (!focusOnMount) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusOnMount]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onCommit(id, trimmed);
    if (!trimmed) setDraft(name);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={`Название workflow ${name}`}
      title="Изменить название workflow"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setFocused(true);
        onFocused();
        if (focusOnMount) event.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(name);
          event.currentTarget.blur();
        }
      }}
      style={{
        width: '100%',
        minWidth: 0,
        height: '26px',
        padding: '0 7px',
        borderRadius: '5px',
        border: `1px solid ${focused ? '#52525b' : 'transparent'}`,
        outline: 'none',
        background: focused ? '#181818' : 'transparent',
        color: '#ededed',
        fontSize: '12px',
        fontWeight: 600,
      }}
    />
  );
}

function ProjectChip({
  projectId,
  project,
  isDefault = false,
  busy = false,
  onEditIcon,
  onResetIcon,
  onUnlink,
}: {
  projectId: string;
  project?: ProjectIconProject;
  isDefault?: boolean;
  busy?: boolean;
  onEditIcon?: () => void;
  onResetIcon?: () => void;
  onUnlink?: () => void;
}) {
  const name = project?.name || 'Недоступный проект';
  const hasIcon = Boolean(project?.icon);
  const editTitle = hasIcon
    ? `Обрезать или заменить иконку проекта «${name}»`
    : `Выбрать иконку проекта «${name}»`;

  return (
    <div
      title={project ? `${project.name}\n${project.path}` : `Проект ${projectId} не найден`}
      aria-busy={busy || undefined}
      style={{
        minWidth: 0,
        maxWidth: '100%',
        height: '28px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 4px 3px 5px',
        borderRadius: '7px',
        border: `1px solid ${isDefault ? '#4c5d75' : '#303030'}`,
        background: isDefault ? 'rgba(59, 91, 128, 0.18)' : '#1c1c1c',
        color: project ? '#d7d7d7' : '#777',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '19px',
          height: '19px',
          flex: '0 0 19px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          borderRadius: '4px',
          border: project?.icon ? 'none' : '1px solid #343434',
          background: project?.icon ? 'transparent' : '#141414',
          color: '#777',
          fontSize: '9px',
          fontWeight: 700,
        }}
      >
        {project?.icon ? (
          <img
            data-project-icon={projectId}
            src={project.icon}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          name.trim().slice(0, 1).toUpperCase() || '?'
        )}
      </span>

      <span
        style={{
          minWidth: 0,
          maxWidth: '170px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '11px',
        }}
      >
        {name}
      </span>

      {isDefault && (
        <span style={{ color: '#9eb6d1', fontSize: '9px', whiteSpace: 'nowrap' }}>
          по умолчанию
        </span>
      )}

      {project && onEditIcon && (
        <IconActionButton title={editTitle} onClick={onEditIcon} busy={busy} size={20}>
          <Pencil size={10} />
        </IconActionButton>
      )}
      {project && onResetIcon && (
        <IconActionButton
          title={`Сбросить иконку проекта «${name}»`}
          onClick={onResetIcon}
          disabled={!hasIcon || busy}
          size={20}
        >
          <RotateCcw size={10} />
        </IconActionButton>
      )}
      {onUnlink && (
        <IconActionButton
          title={`Убрать проект «${name}» из workflow`}
          onClick={onUnlink}
          disabled={busy}
          size={20}
          danger
        >
          <X size={11} />
        </IconActionButton>
      )}
    </div>
  );
}

export default function ProjectIconsSettings() {
  const projects = useProjectsStore((state) => state.projects);
  const updateProject = useProjectsStore((state) => state.updateProject);
  const spaces = useWorkspaceStore((state) => state.spaces);
  const addWorkspaceSpace = useWorkspaceStore((state) => state.addWorkspaceSpace);
  const removeWorkspaceSpace = useWorkspaceStore((state) => state.removeWorkspaceSpace);
  const renameWorkspaceSpace = useWorkspaceStore((state) => state.renameWorkspaceSpace);
  const updateWorkspaceSpaceMetadata = useWorkspaceStore((state) => state.updateWorkspaceSpaceMetadata);
  const projectIconsGrayscalePreview = useUIStore((state) => state.projectIconsGrayscalePreview);
  const setProjectIconsGrayscalePreview = useUIStore((state) => state.setProjectIconsGrayscalePreview);
  const openProjectOrderKey = useWorkspaceStore((state) => Array.from(state.openProjects.keys()).join('\u0000'));

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileRequestRef = useRef<FileRequest | null>(null);
  const [cropTarget, setCropTarget] = useState<IconTarget | null>(null);
  const [cropperSrc, setCropperSrc] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [selectingWorkflowId, setSelectingWorkflowId] = useState<string | null>(null);
  const [newWorkflowId, setNewWorkflowId] = useState<string | null>(null);

  const openProjectIds = openProjectOrderKey ? openProjectOrderKey.split('\u0000') : [];
  const openProjectIdSet = new Set(openProjectIds);
  const openProjectRows = openProjectIds
    .map((id) => projects[id] as ProjectIconProject | undefined)
    .filter((project): project is ProjectIconProject => Boolean(project) && !isInboxProjectId(project.id));
  const archivedProjectRows = (Object.values(projects) as ProjectIconProject[])
    .filter((project) => !openProjectIdSet.has(project.id) && !isInboxProjectId(project.id))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' }));
  const projectRows = [...openProjectRows, ...archivedProjectRows];

  const projectOwnerById = new Map<string, { id: string; name: string }>();
  spaces.forEach((space) => {
    (space.projectIds || []).forEach((projectId) => {
      if (isInboxProjectId(projectId)) return;
      if (!projectOwnerById.has(projectId)) {
        projectOwnerById.set(projectId, { id: space.id, name: space.name });
      }
    });
  });
  const unassignedProjects = projectRows.filter((project) => !projectOwnerById.has(project.id));

  useEffect(() => {
    if (selectingWorkflowId && !spaces.some((space) => space.id === selectingWorkflowId)) {
      setSelectingWorkflowId(null);
    }
  }, [selectingWorkflowId, spaces]);

  const closeCropper = () => {
    setCropperSrc(null);
    setCropTarget(null);
    fileRequestRef.current = null;
  };

  const openCropper = (target: IconTarget, imageSrc: string) => {
    if (busyKey) return;
    fileRequestRef.current = null;
    setCropTarget(target);
    setCropperSrc(imageSrc);
    setStatus(null);
  };

  const openFilePicker = (target: IconTarget, mode: FileRequest['mode'] = 'open') => {
    if (busyKey) return;
    fileRequestRef.current = { target, mode };
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const request = fileRequestRef.current;
    event.target.value = '';
    if (!file || !request) return;

    const key = targetKey(request.target);
    setBusyKey(key);
    setStatus({ tone: 'working', text: 'Обрабатываем изображение…' });
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (request.mode === 'replace' && sameTarget(request.target, cropTarget)) {
        setCropperSrc(dataUrl);
      } else {
        setCropTarget(request.target);
        setCropperSrc(dataUrl);
      }
      setStatus(null);
    } catch (error) {
      console.error('[ProjectIconsSettings] failed to read image:', error);
      setStatus({ tone: 'error', text: 'Не удалось обработать изображение.' });
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const handleCrop = async (base64: string) => {
    const target = cropTarget;
    if (!target) return;
    const key = targetKey(target);
    setBusyKey(key);
    setStatus({ tone: 'working', text: 'Сохраняем иконку…' });
    try {
      if (target.kind === 'workflow') {
        updateWorkspaceSpaceMetadata(target.id, { icon: base64 });
      } else {
        await updateProject(target.id, { icon: base64 });
      }
      setStatus({ tone: 'success', text: 'Иконка сохранена.' });
      closeCropper();
    } catch (error) {
      console.error('[ProjectIconsSettings] failed to save icon:', error);
      setStatus({ tone: 'error', text: 'Не удалось сохранить иконку. Попробуйте ещё раз.' });
      throw error;
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const clearIcon = async (target: IconTarget) => {
    if (busyKey) return;
    const key = targetKey(target);
    setBusyKey(key);
    setStatus({ tone: 'working', text: 'Сбрасываем иконку…' });
    try {
      if (target.kind === 'workflow') {
        updateWorkspaceSpaceMetadata(target.id, { icon: null });
      } else {
        await updateProject(target.id, { icon: null });
      }
      setStatus({ tone: 'success', text: 'Иконка сброшена.' });
    } catch (error) {
      console.error('[ProjectIconsSettings] failed to clear icon:', error);
      setStatus({ tone: 'error', text: 'Не удалось сбросить иконку.' });
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const editProjectIcon = (project: ProjectIconProject) => {
    const target: IconTarget = { kind: 'project', id: project.id };
    if (project.icon) openCropper(target, project.icon);
    else openFilePicker(target);
  };

  const addProjectToWorkflow = (workflowId: string, projectId: string) => {
    const workflow = spaces.find((space) => space.id === workflowId);
    if (!workflow || workflow.projectIds.includes(projectId) || isInboxProjectId(projectId)) return;
    const previousOwner = projectOwnerById.get(projectId);
    updateWorkspaceSpaceMetadata(workflowId, { projectIds: [...workflow.projectIds, projectId] });
    setSelectingWorkflowId(null);
    setStatus({
      tone: 'success',
      text: previousOwner && previousOwner.id !== workflowId
        ? `Проект перенесён из workflow «${previousOwner.name}».`
        : 'Проект добавлен в workflow.',
    });
  };

  const unlinkProject = (workflowId: string, projectId: string) => {
    const workflow = spaces.find((space) => space.id === workflowId);
    if (!workflow) return;
    updateWorkspaceSpaceMetadata(workflowId, {
      projectIds: workflow.projectIds.filter((id) => id !== projectId),
    });
    setStatus({ tone: 'success', text: 'Проект перемещён в «Без workflow».' });
  };

  const createWorkflow = () => {
    const id = addWorkspaceSpace({ activate: false, name: 'Workflow' });
    if (!id) return;
    setNewWorkflowId(id);
    setSelectingWorkflowId(null);
    setStatus({ tone: 'success', text: 'Workflow создан в фоне.' });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
        <div
          style={{
            minWidth: 0,
            fontSize: '11px',
            fontWeight: 600,
            color: '#777',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          Иконки workflow и проектов
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            role="switch"
            aria-checked={projectIconsGrayscalePreview}
            data-project-icons-grayscale-toggle
            title="Временный A/B: показывать project icons в чёрно-белом виде, не меняя исходную картинку"
            style={{
              ...headerActionStyle,
              background: projectIconsGrayscalePreview ? 'rgba(148,163,184,0.16)' : '#242424',
              color: projectIconsGrayscalePreview ? '#e2e5e9' : '#9a9ca1',
            }}
            onClick={() => setProjectIconsGrayscalePreview(!projectIconsGrayscalePreview)}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: projectIconsGrayscalePreview ? '#b8bdc5' : '#555',
              }}
            />
            Ч/Б проекты
          </button>
          <button
            type="button"
            title="Создать workflow, не переключая текущий"
            aria-label="Создать workflow в фоне"
            style={headerActionStyle}
            onClick={createWorkflow}
          >
            + Workflow
          </button>
        </div>
      </div>

      {status && (
        <div
          role={status.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          style={{
            minHeight: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginBottom: '6px',
            color: status.tone === 'error' ? '#f87171' : status.tone === 'success' ? '#86b895' : '#a8a8ad',
            fontSize: '10px',
          }}
        >
          {status.tone === 'working' && <Loader2 size={11} className="animate-spin" />}
          {status.text}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {spaces.map((space) => {
          const workflowTarget: IconTarget = { kind: 'workflow', id: space.id };
          const workflowBusy = busyKey === targetKey(workflowTarget);
          const linkedIds = (space.projectIds || []).filter((projectId) => !isInboxProjectId(projectId));
          const availableProjects = projectRows.filter((project) => !linkedIds.includes(project.id));
          const selectorOpen = selectingWorkflowId === space.id;

          return (
            <section
              key={space.id}
              aria-label={`Workflow ${space.name}`}
              style={{
                padding: '6px 7px 7px',
                borderRadius: '8px',
                border: '1px solid #2d2d2d',
                background: '#1d1d1d',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(100px, 1fr) auto',
                  alignItems: 'center',
                  gap: '7px',
                }}
              >
                <div
                  aria-label={`Иконка workflow ${space.name}`}
                  aria-busy={workflowBusy || undefined}
                  style={{
                    width: '28px',
                    height: '28px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    borderRadius: '7px',
                    border: 'none',
                    background: space.icon ? 'transparent' : workflowFallbackColor(space.id),
                    color: '#fff',
                    fontSize: '11px',
                    fontWeight: 700,
                  }}
                >
                  {workflowBusy ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : space.icon ? (
                    <img src={space.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    space.name.trim().slice(0, 1).toUpperCase() || 'W'
                  )}
                </div>

                <WorkflowNameEditor
                  id={space.id}
                  name={space.name}
                  focusOnMount={newWorkflowId === space.id}
                  onFocused={() => {
                    if (newWorkflowId === space.id) setNewWorkflowId(null);
                  }}
                  onCommit={renameWorkspaceSpace}
                />

                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <IconActionButton
                    title={`Выбрать цветную иконку workflow «${space.name}»`}
                    onClick={() => openFilePicker(workflowTarget)}
                    disabled={Boolean(busyKey)}
                    busy={workflowBusy}
                  >
                    <ImagePlus size={13} />
                  </IconActionButton>
                  <IconActionButton
                    title={`Обрезать иконку workflow «${space.name}»`}
                    onClick={() => {
                      if (space.icon) openCropper(workflowTarget, space.icon);
                    }}
                    disabled={!space.icon || Boolean(busyKey)}
                  >
                    <Crop size={13} />
                  </IconActionButton>
                  <IconActionButton
                    title={`Сбросить иконку workflow «${space.name}»`}
                    onClick={() => void clearIcon(workflowTarget)}
                    disabled={!space.icon || Boolean(busyKey)}
                  >
                    <RotateCcw size={13} />
                  </IconActionButton>

                  <span aria-hidden="true" style={{ width: '1px', height: '18px', margin: '0 1px', background: '#353535' }} />

                  <IconActionButton
                    title={selectorOpen ? 'Закрыть выбор проекта' : 'Добавить или переместить проект в workflow'}
                    onClick={() => setSelectingWorkflowId((current) => (current === space.id ? null : space.id))}
                    disabled={availableProjects.length === 0 || Boolean(busyKey)}
                  >
                    <Plus size={14} />
                  </IconActionButton>
                  <IconActionButton
                    title={spaces.length <= 1 ? 'Последний workflow удалить нельзя' : `Удалить workflow «${space.name}»`}
                    onClick={() => removeWorkspaceSpace(space.id)}
                    disabled={spaces.length <= 1 || Boolean(busyKey)}
                    danger
                  >
                    <Trash2 size={13} />
                  </IconActionButton>
                </div>
              </div>

              <div
                style={{
                  position: 'relative',
                  minHeight: '31px',
                  marginLeft: '13px',
                  padding: '6px 0 0 17px',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ position: 'absolute', left: 0, top: '-1px', bottom: '13px', width: '1px', background: '#3a3a3a' }}
                />
                <span
                  aria-hidden="true"
                  style={{ position: 'absolute', left: 0, top: '18px', width: '12px', height: '1px', background: '#3a3a3a' }}
                />

                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '5px' }}>
                  {linkedIds.map((projectId, index) => {
                    const project = projects[projectId] as ProjectIconProject | undefined;
                    const projectTarget: IconTarget = { kind: 'project', id: projectId };
                    return (
                      <ProjectChip
                        key={projectId}
                        projectId={projectId}
                        project={project}
                        isDefault={index === 0}
                        busy={busyKey === targetKey(projectTarget)}
                        onEditIcon={project ? () => editProjectIcon(project) : undefined}
                        onResetIcon={project ? () => void clearIcon(projectTarget) : undefined}
                        onUnlink={() => unlinkProject(space.id, projectId)}
                      />
                    );
                  })}

                  {linkedIds.length === 0 && !selectorOpen && (
                    <button
                      type="button"
                      title="Выбрать первый проект workflow"
                      disabled={availableProjects.length === 0}
                      onClick={() => setSelectingWorkflowId(space.id)}
                      style={{
                        height: '26px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '0 8px',
                        borderRadius: '6px',
                        border: '1px dashed #424242',
                        background: 'transparent',
                        color: availableProjects.length > 0 ? '#888' : '#555',
                        fontSize: '10px',
                        cursor: availableProjects.length > 0 ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <Plus size={11} />
                      Выберите проект по умолчанию
                    </button>
                  )}

                  {selectorOpen && (
                    <select
                      autoFocus
                      defaultValue=""
                      aria-label={`Добавить или переместить проект в workflow ${space.name}`}
                      title="Проект может принадлежать только одному workflow"
                      onChange={(event) => {
                        if (event.target.value) addProjectToWorkflow(space.id, event.target.value);
                      }}
                      onBlur={() => {
                        setSelectingWorkflowId((current) => (current === space.id ? null : current));
                      }}
                      style={{
                        height: '28px',
                        maxWidth: '280px',
                        padding: '0 24px 0 8px',
                        borderRadius: '7px',
                        border: '1px solid #4a4a4a',
                        outline: 'none',
                        background: '#242424',
                        color: '#dedede',
                        fontSize: '11px',
                      }}
                    >
                      <option value="" disabled>Добавить или переместить проект…</option>
                      {availableProjects.map((project) => {
                        const owner = projectOwnerById.get(project.id);
                        return (
                          <option key={project.id} value={project.id}>
                            {owner && owner.id !== space.id
                              ? `${project.name} — перенести из «${owner.name}»`
                              : project.name}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <section style={{ marginTop: '13px' }} aria-label="Проекты без workflow">
        <div
          style={{
            marginBottom: '6px',
            color: '#777',
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          Без workflow
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '5px' }}>
          {unassignedProjects.map((project) => {
            const projectTarget: IconTarget = { kind: 'project', id: project.id };
            return (
              <ProjectChip
                key={project.id}
                projectId={project.id}
                project={project}
                busy={busyKey === targetKey(projectTarget)}
                onEditIcon={() => editProjectIcon(project)}
                onResetIcon={() => void clearIcon(projectTarget)}
              />
            );
          })}
          {unassignedProjects.length === 0 && (
            <span style={{ color: '#666', fontSize: '10px', padding: '4px 0' }}>
              Непривязанных проектов нет.
            </span>
          )}
        </div>
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.svg"
        hidden
        onChange={(event) => void handleFileSelect(event)}
      />

      {cropperSrc && cropTarget && (
        <IconCropper
          key={targetKey(cropTarget)}
          imageSrc={cropperSrc}
          onCrop={handleCrop}
          onCancel={closeCropper}
          onReplaceRequest={() => openFilePicker(cropTarget, 'replace')}
        />
      )}
    </div>
  );
}
