import React, { useEffect, useRef, useState } from 'react';
import {
  Crop,
  ImagePlus,
  Loader2,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import IconCropper from '../Workspace/IconCropper.jsx';
import { useInlineRenameInputRef } from '../../hooks/useInlineRenameInput';
import { workflowFallbackColor } from '../../utils/workflowVisuals.mjs';

type IconTarget = { kind: 'workflow'; id: string };

type FileRequest = {
  target: IconTarget;
  mode: 'open' | 'replace';
};

type StatusMessage = {
  tone: 'working' | 'success' | 'error';
  text: string;
};

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
  disabled,
  onCommit,
  onFocused,
  saveOnEscape = false,
}: {
  id: string;
  name: string;
  focusOnMount: boolean;
  disabled: boolean;
  onCommit: (id: string, name: string) => void;
  onFocused: () => void;
  saveOnEscape?: boolean;
}) {
  const renameInput = useInlineRenameInputRef(focusOnMount);
  const inputRef = renameInput.nodeRef;
  const [draft, setDraft] = useState(name);
  const [focused, setFocused] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(name);
  }, [name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onCommit(id, trimmed);
    if (!trimmed) setDraft(name);
  };

  return (
    <input
      ref={renameInput.ref}
      value={draft}
      disabled={disabled}
      aria-label={`Название workflow ${name}`}
      title="Изменить название workflow"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        cancelled.current = false;
        setFocused(true);
        onFocused();
      }}
      onBlur={() => {
        setFocused(false);
        if (!cancelled.current) commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = !saveOnEscape;
          if(!saveOnEscape)setDraft(name);
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

export default function WorkflowSettings({workflowId}:{workflowId?:string}={}) {
  const spaces = useWorkspaceStore((state) => state.spaces);
  const addWorkspaceSpace = useWorkspaceStore((state) => state.addWorkspaceSpace);
  const removeWorkspaceSpace = useWorkspaceStore((state) => state.removeWorkspaceSpace);
  const renameWorkspaceSpace = useWorkspaceStore((state) => state.renameWorkspaceSpace);
  const updateWorkspaceSpaceMetadata = useWorkspaceStore((state) => state.updateWorkspaceSpaceMetadata);
  const reorderWorkspaceSpaces = useWorkspaceStore((state) => state.reorderWorkspaceSpaces);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileRequestRef = useRef<FileRequest | null>(null);
  const mutationLock = useRef(false);
  const [cropTarget, setCropTarget] = useState<IconTarget | null>(null);
  const [cropperSrc, setCropperSrc] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [newWorkflowId, setNewWorkflowId] = useState<string | null>(null);

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
      if (!useWorkspaceStore.getState().spaces.some(space => space.id === target.id)) throw new Error('Workflow no longer exists');
      const saved = await updateWorkspaceSpaceMetadata(target.id, { icon: base64 });
      if (saved === false) throw new Error('Icon change refused');
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
      if (!useWorkspaceStore.getState().spaces.some(space => space.id === target.id)) throw new Error('Workflow no longer exists');
      const saved = await updateWorkspaceSpaceMetadata(target.id, { icon: null });
      if (saved === false) throw new Error('Icon change refused');
      setStatus({ tone: 'success', text: 'Иконка сброшена.' });
    } catch (error) {
      console.error('[ProjectIconsSettings] failed to clear icon:', error);
      setStatus({ tone: 'error', text: 'Не удалось сбросить иконку.' });
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const mutateWorkflow = async (action: () => unknown) => {
    if (busyKey || mutationLock.current) return;
    mutationLock.current = true;
    setBusyKey('workflow-mutation');
    try {
      const result = await action();
      if (result === false || result === null) throw new Error('Workflow change was refused');
      setStatus(null);
    } catch {
      setStatus({ tone: 'error', text: 'Не удалось изменить workflow. Попробуйте ещё раз.' });
    } finally { mutationLock.current = false; setBusyKey(null); }
  };

  const createWorkflow = () => void mutateWorkflow(async () => {
    const id = await addWorkspaceSpace({ activate: false, name: 'Workflow' });
    if (!id) return false;
    setNewWorkflowId(id);
  });

  const moveWorkflow = (id: string, direction: number) => void mutateWorkflow(() => {
    const current = useWorkspaceStore.getState().spaces;
    const ordinary = current.filter((space: any) => space.kind !== 'inbox');
    const index = ordinary.findIndex((space) => space.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ordinary.length) return false;
    [ordinary[index], ordinary[next]] = [ordinary[next], ordinary[index]];
    return reorderWorkspaceSpaces([...ordinary.map((space) => space.id), ...current.filter((space: any) => space.kind === 'inbox').map((space) => space.id)]);
  });

  return (
    <div>
      {!workflowId && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
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
          Workflows
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            title="Создать workflow, не переключая текущий"
            aria-label="Создать workflow в фоне"
            style={headerActionStyle}
            onClick={createWorkflow}
            disabled={Boolean(busyKey)}
          >
            + Workflow
          </button>
        </div>
      </div>}

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
        {[...spaces.filter((space: any) => space.kind !== 'inbox'), ...spaces.filter((space: any) => space.kind === 'inbox')].filter(space=>!workflowId || space.id===workflowId).map((space) => {
          const workflowTarget: IconTarget = { kind: 'workflow', id: space.id };
          const workflowBusy = busyKey === targetKey(workflowTarget);
          const inbox = (space as any).kind === 'inbox';
          const ordinary = spaces.filter((item: any) => item.kind !== 'inbox');
          const orderIndex = ordinary.findIndex((item) => item.id === space.id);

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
                  gridTemplateColumns: '28px minmax(80px, 1fr)',
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
                  saveOnEscape={!!workflowId}
                  focusOnMount={newWorkflowId === space.id}
                  disabled={Boolean(busyKey)}
                  onFocused={() => {
                    if (newWorkflowId === space.id) setNewWorkflowId(null);
                  }}
                  onCommit={(id, name) => void mutateWorkflow(() => renameWorkspaceSpace(id, name))}
                />

                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
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

                  <IconActionButton title={`Переместить workflow «${space.name}» влево`}
                    onClick={() => moveWorkflow(space.id, -1)} disabled={inbox || orderIndex <= 0 || Boolean(busyKey)}><ArrowUp size={13} /></IconActionButton>
                  <IconActionButton title={`Переместить workflow «${space.name}» вправо`}
                    onClick={() => moveWorkflow(space.id, 1)} disabled={inbox || orderIndex >= ordinary.length - 1 || Boolean(busyKey)}><ArrowDown size={13} /></IconActionButton>
                  <IconActionButton
                    title={inbox ? 'Системный Inbox нельзя удалить' : `Удалить workflow «${space.name}»`}
                    onClick={() => { if (!inbox) void mutateWorkflow(() => removeWorkspaceSpace(space.id)); }}
                    disabled={inbox || Boolean(busyKey)} danger><Trash2 size={13} /></IconActionButton>
                  {inbox && <span style={{ color: '#888', fontSize: 11 }}>Системный Inbox</span>}

                </div>
              </div>

            </section>
          );
        })}
      </div>

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
