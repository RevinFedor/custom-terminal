import React from 'react';
import { useUIStore } from '../../store/useUIStore';

export default function ToastContainer() {
  const { toasts, removeToast } = useUIStore();

  return (
    <div
      style={{
        position: 'fixed',
        top: '52px',
        right: '16px',
        zIndex: 9999,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxWidth: '340px'
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm transform transition-all duration-300 ease-out animate-slide-in ${
            toast.persistent ? '' : 'cursor-pointer'
          } ${
            toast.type === 'success' ? 'bg-[#22c55e]/90 text-white' :
            toast.type === 'error' ? 'bg-[#ef4444]/90 text-white' :
            toast.type === 'warning' ? 'bg-[#f59e0b]/90 text-white' :
            'bg-[#3b82f6]/90 text-white'
          }`}
          style={toast.persistent ? {
            borderLeft: '3px solid rgba(255,255,255,0.5)',
            paddingRight: '8px',
          } : undefined}
          onClick={() => !toast.persistent && removeToast(toast.id)}
        >
          {/* ✕ close button — left side for persistent toasts */}
          {toast.persistent && (
            <span
              className="shrink-0 cursor-pointer rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
              style={{ width: '18px', height: '18px', fontSize: '11px', opacity: 0.7 }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
              onClick={(e) => { e.stopPropagation(); removeToast(toast.id); }}
            >
              ✕
            </span>
          )}
          <span className="text-sm shrink-0">
            {toast.type === 'success' ? '✓' :
             toast.type === 'error' ? '✗' :
             toast.type === 'warning' ? '⚠' : 'ℹ'}
          </span>
          <span className="text-xs font-medium flex-1">{toast.message}</span>
          {/* Copy button — right side, only if toast has copyText */}
          {toast.copyText && (
            <span
              className="shrink-0 cursor-pointer rounded flex items-center justify-center hover:bg-white/20 transition-colors"
              style={{ padding: '2px 5px', fontSize: '10px', opacity: 0.7, border: '1px solid rgba(255,255,255,0.3)', borderRadius: '4px' }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
              onClick={(e) => {
                e.stopPropagation();
                const { clipboard } = window.require('electron');
                clipboard.writeText(toast.copyText!);
                e.currentTarget.textContent = 'ok';
                setTimeout(() => { if (e.currentTarget) e.currentTarget.textContent = 'copy'; }, 800);
              }}
            >
              copy
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
