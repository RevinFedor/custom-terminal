import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, CircleHelp, MousePointer2 } from 'lucide-react';
import { useControlHelpStore } from '../../store/useControlHelpStore';

interface HelpButtonProps {
  onOpenHelp: () => void;
}

export default function HelpButton({ onOpenHelp }: HelpButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hintsEnabled = useControlHelpStore((state) => state.enabled);
  const setHintsEnabled = useControlHelpStore((state) => state.setEnabled);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside, true);
    return () => window.removeEventListener('pointerdown', closeOutside, true);
  }, [menuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) setMenuOpen(false);
      if (hintsEnabled) setHintsEnabled(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hintsEnabled, menuOpen, setHintsEnabled]);

  const openHelp = () => {
    setMenuOpen(false);
    onOpenHelp();
  };

  const toggleHints = () => {
    setHintsEnabled(!hintsEnabled);
    setMenuOpen(false);
  };

  const active = menuOpen || hintsEnabled;

  return (
    <div ref={rootRef} style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as any}>
      <button
        type="button"
        data-testid="help-button"
        aria-label="Справка и подсказки"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-pressed={hintsEnabled}
        onClick={() => setMenuOpen((value) => !value)}
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors"
        style={{
          color: active ? '#74c7ec' : '#a4abb5',
          backgroundColor: active ? 'rgba(116, 199, 236, 0.15)' : 'rgba(255, 255, 255, 0.045)',
          border: `1px solid ${active ? 'rgba(116, 199, 236, 0.34)' : 'rgba(255, 255, 255, 0.08)'}`,
          boxShadow: hintsEnabled ? '0 0 0 1px rgba(116, 199, 236, 0.08)' : 'none',
        }}
      >
        <CircleHelp size={16} />
      </button>

      {menuOpen && (
        <div
          role="menu"
          data-testid="help-button-menu"
          style={{
            position: 'absolute',
            top: 34,
            left: 0,
            zIndex: 30000,
            width: 270,
            padding: 5,
            border: '1px solid #343941',
            borderRadius: 7,
            background: '#1b1e23',
            boxShadow: '0 14px 38px rgba(0, 0, 0, 0.55)',
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={openHelp}
            className="hover:bg-white/[0.06]"
            style={menuItemStyle}
          >
            <BookOpen size={15} color="#74c7ec" style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>
              <span style={menuTitleStyle}>Открыть справку</span>
              <span style={menuDescriptionStyle}>Флоу, горячие клавиши и диагностика</span>
            </span>
          </button>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={hintsEnabled}
            data-testid="control-hints-toggle"
            onClick={toggleHints}
            className="hover:bg-white/[0.06]"
            style={menuItemStyle}
          >
            <MousePointer2 size={15} color={hintsEnabled ? '#a6e3a1' : '#9aa1aa'} style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={menuTitleStyle}>Подсказки интерфейса</span>
              <span style={menuDescriptionStyle}>Показывать действие при наведении</span>
            </span>
            <span
              aria-hidden="true"
              style={{
                width: 27,
                height: 15,
                padding: 2,
                display: 'flex',
                justifyContent: hintsEnabled ? 'flex-end' : 'flex-start',
                flexShrink: 0,
                borderRadius: 999,
                background: hintsEnabled ? 'rgba(166, 227, 161, 0.32)' : '#333840',
              }}
            >
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: hintsEnabled ? '#a6e3a1' : '#8b929c' }} />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 51,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 9,
  padding: '8px 9px',
  border: 'none',
  borderRadius: 5,
  background: 'transparent',
  color: '#f1f3f5',
  textAlign: 'left',
  cursor: 'pointer',
};

const menuTitleStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 650,
};

const menuDescriptionStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 3,
  color: '#8d949d',
  fontSize: 10.5,
  lineHeight: 1.35,
};
