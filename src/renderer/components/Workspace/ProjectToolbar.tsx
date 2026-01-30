import React, { useState } from 'react';
import { Home, Minimize2 } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { compressLogs } from '../../utils/compressLogs';

interface ProjectToolbarProps {
  width: number;
}

export default function ProjectToolbar({ width }: ProjectToolbarProps) {
  const { currentView, setCurrentView, showToast } = useUIStore();
  const [isCompressing, setIsCompressing] = useState(false);

  const isHomeActive = currentView === 'home';

  const handleCompressLogs = async () => {
    if (isCompressing) return;

    setIsCompressing(true);
    try {
      const clipboardText = await navigator.clipboard.readText();
      const result = compressLogs(clipboardText);

      if (result.success) {
        await navigator.clipboard.writeText(result.compressed);
        showToast(result.message, 'success');
      } else {
        showToast(result.message, 'warning');
      }
    } catch (err) {
      showToast('Ошибка доступа к буферу обмена', 'error');
    } finally {
      setIsCompressing(false);
    }
  };

  const buttonStyle = (isActive: boolean) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '0 12px',
    height: '100%',
    fontSize: '13px',
    color: isActive ? '#fff' : '#888',
    backgroundColor: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
    borderTop: isActive ? '2px solid rgba(255,255,255,0.7)' : '2px solid transparent',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    border: 'none',
    outline: 'none',
  });

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>, isActive: boolean) => {
    if (!isActive) {
      e.currentTarget.style.color = '#fff';
      e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>, isActive: boolean) => {
    if (!isActive) {
      e.currentTarget.style.color = '#888';
      e.currentTarget.style.backgroundColor = 'transparent';
    }
  };

  return (
    <div
      className="h-[30px] bg-panel flex items-stretch border-l border-border-main"
      style={{ width }}
    >
      {/* Home Button */}
      <button
        onClick={() => setCurrentView(isHomeActive ? 'terminal' : 'home')}
        style={buttonStyle(isHomeActive)}
        onMouseEnter={(e) => handleMouseEnter(e, isHomeActive)}
        onMouseLeave={(e) => handleMouseLeave(e, isHomeActive)}
        title="Project Home"
      >
        <Home size={14} />
        <span>Home</span>
      </button>

      {/* Compress Logs Button */}
      <button
        onClick={handleCompressLogs}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
        title="Сжать логи из буфера обмена"
        disabled={isCompressing}
      >
        <Minimize2 size={14} className={isCompressing ? 'animate-pulse' : ''} />
        <span>Logs</span>
      </button>
    </div>
  );
}
