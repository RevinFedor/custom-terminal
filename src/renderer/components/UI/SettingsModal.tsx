import React, { useEffect } from 'react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: '#1a1a1a',
          borderRadius: '16px',
          border: '1px solid #333',
          width: '480px',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: '#fff' }}>
            Settings
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#666',
              fontSize: '24px',
              cursor: 'pointer',
              lineHeight: 1
            }}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          {/* Tab Colors Reference */}
          <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#fff', margin: '0 0 16px 0' }}>
            Tab Colors
          </h3>

          {/* System Colors */}
          <div style={{
            padding: '14px',
            backgroundColor: '#222',
            border: '1px solid #333',
            borderRadius: '10px',
            marginBottom: '12px'
          }}>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              System (Auto-assigned)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: 'rgba(34, 197, 94, 0.2)', border: '2px solid rgb(34, 197, 94)' }} />
              <div>
                <div style={{ fontSize: '14px', color: '#fff', fontWeight: '500' }}>Green — System Tool</div>
                <div style={{ fontSize: '12px', color: '#666' }}>AI agents (Gemini CLI, Claude Code)</div>
              </div>
            </div>
          </div>

          {/* User Colors */}
          <div style={{
            padding: '14px',
            backgroundColor: '#222',
            border: '1px solid #333',
            borderRadius: '10px'
          }}>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#666', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              User (Manual via Right-Click)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'transparent', border: '2px solid #666' }} />
                <span style={{ fontSize: '13px', color: '#888' }}>Default — no special meaning</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'rgba(239, 68, 68, 0.2)', border: '2px solid rgb(239, 68, 68)' }} />
                <span style={{ fontSize: '13px', color: '#888' }}>Red — for your labels</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'rgba(234, 179, 8, 0.2)', border: '2px solid rgb(234, 179, 8)' }} />
                <span style={{ fontSize: '13px', color: '#888' }}>Yellow — for your labels</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'rgba(59, 130, 246, 0.2)', border: '2px solid rgb(59, 130, 246)' }} />
                <span style={{ fontSize: '13px', color: '#888' }}>Blue — for your labels</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'rgba(168, 85, 247, 0.2)', border: '2px solid rgb(168, 85, 247)' }} />
                <span style={{ fontSize: '13px', color: '#888' }}>Purple — for your labels</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #333',
          display: 'flex',
          justifyContent: 'flex-end'
        }}>
          <span style={{ fontSize: '11px', color: '#555' }}>Press Esc or click outside to close</span>
        </div>
      </div>
    </div>
  );
}
