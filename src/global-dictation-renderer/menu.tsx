// Menu overlay — small popover that appears above the chip when the user
// clicks the idle chip. Three actions: Open App / Speak / Copy.
//
// Window owns its own blur-close logic (main hooks `blur` → close), so we
// don't need to do anything special on click-away here.
//
// Visual contract:
//   - Buttons are full-width (no width based on label length); container
//     decides the width.
//   - Label is centered, single-line, ellipsised if too long.
//   - Hover: subtle bg lighten. Active (mousedown): brief darker flash that
//     persists ~250ms after release so the user gets visual confirmation
//     that the click registered before the window closes.
//   - Slide-up entry animation on mount (each row staggered slightly).

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

const { ipcRenderer } = window.require('electron');

function dlog(msg: string) {
  try { ipcRenderer.send('log:renderer', '[GD:menu] ' + msg); } catch {}
}

function MenuApp() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Defer one frame so the initial transform=translateY(8px) lands first.
    requestAnimationFrame(() => setMounted(true));
    dlog('mounted');
  }, []);

  const pick = (action: 'open-settings' | 'speak' | 'copy') => {
    dlog('pick ' + action);
    ipcRenderer.invoke('global-dict:menu:select', action).catch(() => {});
  };

  // Equal gap between rows AND between the last row and the chip below.
  // The chip itself is rendered outside this window — main controls the gap
  // via the menuGap setting and the y-position of the popover. Here we
  // simply use a uniform gap=8 between rows inside the popover so visually
  // it lines up cleanly.
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '8px 8px',
        boxSizing: 'border-box',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      }}
    >
      <MenuButton index={0} mounted={mounted} onClick={() => pick('open-settings')} label="Open App" icon={<GearIcon />} />
      <MenuButton index={1} mounted={mounted} onClick={() => pick('speak')} label="Speak" icon={<MicIcon />} />
      <MenuButton index={2} mounted={mounted} onClick={() => pick('copy')} label="Copy" icon={<CopyIcon />} />
    </div>
  );
}

function MenuButton({ label, icon, onClick, index, mounted }: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  index: number;
  mounted: boolean;
}) {
  const [hover, setHover] = useState(false);
  // Persist the "pressed" flash for ~300ms after release so the user sees
  // confirmation even though main closes the popover within milliseconds.
  const [pressed, setPressed] = useState(false);
  const [flashed, setFlashed] = useState(false);

  const bg = pressed || flashed ? '#2a2a2c' : (hover ? '#28282a' : '#1f1f22');

  const handleClick = () => {
    setFlashed(true);
    setTimeout(() => setFlashed(false), 250);
    onClick();
  };

  // Staggered slide-up: bottom row appears first, then the row above, etc.
  // 2 - index → row 0 (top) has biggest delay; tweak if reversed.
  const delay = (2 - index) * 35;

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onClick={handleClick}
      style={{
        position: 'relative',
        width: '100%',
        height: 44,
        flexShrink: 0,
        borderRadius: 12,
        border: 'none',
        cursor: 'default',
        background: bg,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 14px',
        fontSize: 13,
        fontWeight: 500,
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(10px)',
        transition: `opacity 220ms ease ${delay}ms, transform 240ms cubic-bezier(.4,1.5,.5,1) ${delay}ms, background 120ms ease`,
        overflow: 'hidden',
      }}
    >
      <span style={{
        width: 18, height: 18,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
      }}>{icon}</span>
      <span style={{
        flex: 1,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        // Leave room for the absolutely-positioned icon (14 px padding + 18 icon + 4 gap).
        paddingLeft: 18,
      }}>{label}</span>
    </button>
  );
}

const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const MicIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <line x1="12" y1="18" x2="12" y2="22" />
  </svg>
);

const CopyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

createRoot(document.getElementById('root')!).render(<MenuApp />);
