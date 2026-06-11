import React, { useRef, useState } from 'react';
import { ImagePlus, RotateCcw, Trash2 } from 'lucide-react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import IconCropper from '../Workspace/IconCropper.jsx';

type ProjectIconProject = {
  id: string;
  name: string;
  path: string;
  icon?: string | null;
};

function compactPath(projectPath: string) {
  if (!projectPath || projectPath.startsWith('__unset__')) return 'No path';
  const parts = projectPath.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function readFileAsDataUrl(file: File, onDone: (src: string) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') onDone(reader.result);
  };
  reader.readAsDataURL(file);
}

const iconButtonStyle: React.CSSProperties = {
  height: '30px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  padding: '0 10px',
  borderRadius: '6px',
  border: '1px solid #333',
  background: '#242424',
  color: '#d4d4d4',
  fontSize: '12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function ProjectIconsSettings() {
  const projects = useProjectsStore((s) => s.projects);
  const updateProject = useProjectsStore((s) => s.updateProject);
  const openProjectOrderKey = useWorkspaceStore((s) => Array.from(s.openProjects.keys()).join('\u0000'));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingProjectIdRef = useRef<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [cropperSrc, setCropperSrc] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);

  const openProjectIds = openProjectOrderKey ? openProjectOrderKey.split('\u0000') : [];
  const openProjectIdSet = new Set(openProjectIds);
  const activeProjectRows = openProjectIds
    .map((id) => projects[id] as ProjectIconProject | undefined)
    .filter((project): project is ProjectIconProject => Boolean(project));
  const restProjectRows = (Object.values(projects) as ProjectIconProject[])
    .filter((project) => !openProjectIdSet.has(project.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const totalProjectCount = activeProjectRows.length + restProjectRows.length;

  const setTargetProject = (projectId: string | null) => {
    pendingProjectIdRef.current = projectId;
    setPendingProjectId(projectId);
  };

  const openFilePicker = (projectId: string) => {
    setTargetProject(projectId);
    fileInputRef.current?.click();
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const projectId = pendingProjectIdRef.current;
    event.target.value = '';
    if (!file || !projectId) return;
    readFileAsDataUrl(file, setCropperSrc);
  };

  const closeCropper = () => {
    setCropperSrc(null);
    setTargetProject(null);
  };

  const handleCrop = (base64: string) => {
    const projectId = pendingProjectIdRef.current;
    closeCropper();
    if (!projectId) return;
    updateProject(projectId, { icon: base64 }).catch((error) => {
      console.error('[ProjectIconsSettings] failed to save icon:', error);
    });
  };

  const clearIcon = (projectId: string) => {
    updateProject(projectId, { icon: null }).catch((error) => {
      console.error('[ProjectIconsSettings] failed to clear icon:', error);
    });
  };

  const renderProjectRow = (project: ProjectIconProject) => (
    <div
      key={project.id}
      style={{
        display: 'grid',
        gridTemplateColumns: '34px minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 10px',
        borderRadius: '8px',
        border: '1px solid #2a2a2a',
        background: '#1f1f1f',
      }}
    >
      <div style={{
        width: '32px',
        height: '32px',
        borderRadius: '7px',
        border: '1px solid #333',
        background: '#151515',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        color: '#777',
        fontSize: '13px',
        fontWeight: 700,
      }}>
        {project.icon ? (
          <img src={project.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span>{project.name.trim().slice(0, 1).toUpperCase() || '?'}</span>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', color: '#e8e8e8', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </div>
        <div title={project.path} style={{ fontSize: '10px', color: '#666', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {compactPath(project.path)}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button type="button" style={iconButtonStyle} onClick={() => openFilePicker(project.id)}>
          <ImagePlus size={14} />
          Выбрать
        </button>
        <button
          type="button"
          style={{ ...iconButtonStyle, opacity: project.icon ? 1 : 0.45, cursor: project.icon ? 'pointer' : 'default' }}
          disabled={!project.icon}
          onClick={() => {
            if (project.icon) {
              setTargetProject(project.id);
              setCropperSrc(project.icon);
            }
          }}
        >
          <RotateCcw size={13} />
          Обрезать
        </button>
        <button
          type="button"
          title="Сбросить"
          style={{ ...iconButtonStyle, width: '32px', padding: 0, color: project.icon ? '#f87171' : '#555', opacity: project.icon ? 1 : 0.45, cursor: project.icon ? 'pointer' : 'default' }}
          disabled={!project.icon}
          onClick={() => clearIcon(project.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{
        fontSize: '11px',
        fontWeight: 600,
        color: '#666',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginBottom: '10px',
      }}>
        Иконки проектов
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{
          fontSize: '10px',
          fontWeight: 600,
          color: '#888',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginTop: '2px',
        }}>
          Активные проекты
        </div>
        {activeProjectRows.map(renderProjectRow)}

        {activeProjectRows.length === 0 && totalProjectCount > 0 && (
          <div style={{ color: '#777', fontSize: '12px', padding: '10px 0' }}>
            Нет открытых проектов.
          </div>
        )}

        {restProjectRows.length > 0 && (
          <button
            type="button"
            style={{
              ...iconButtonStyle,
              alignSelf: 'flex-start',
              marginTop: '8px',
              background: '#1a1a1a',
              color: '#aaa',
            }}
            onClick={() => setShowRest((value) => !value)}
          >
            {showRest ? 'Скрыть остальные' : `Показать еще (${restProjectRows.length})`}
          </button>
        )}

        {showRest && restProjectRows.length > 0 && (
          <>
            <div style={{
              fontSize: '10px',
              fontWeight: 600,
              color: '#888',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginTop: '4px',
            }}>
              Остальные проекты
            </div>
            {restProjectRows.map(renderProjectRow)}
          </>
        )}

        {totalProjectCount === 0 && (
          <div style={{ color: '#777', fontSize: '12px', padding: '16px 0' }}>
            Проектов нет.
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.svg"
        hidden
        onChange={handleFileSelect}
      />

      {cropperSrc && pendingProjectId && (
        <IconCropper
          imageSrc={cropperSrc}
          onCrop={handleCrop}
          onCancel={closeCropper}
        />
      )}
    </div>
  );
}
