import React, { useEffect, useState } from 'react';

const { ipcRenderer } = window.require('electron');

export default function ShutdownOverlay() {
  const [visible, setVisible] = useState(false);
  const [tabsCount, setTabsCount] = useState(0);

  useEffect(() => {
    const handler = (_e: any, payload: { show: boolean; tabsCount?: number }) => {
      if (payload.show) {
        setTabsCount(payload.tabsCount ?? 0);
        setVisible(true);
      } else {
        setVisible(false);
      }
    };
    ipcRenderer.on('shutdown:overlay', handler);
    return () => { ipcRenderer.removeListener('shutdown:overlay', handler); };
  }, []);

  if (!visible) return null;

  const message = tabsCount > 0
    ? `Сохраняю ${tabsCount} активных AI-сессий…`
    : 'Сохраняю окна и вкладки…';

  const detail = tabsCount > 0
    ? 'При следующем запуске сессии восстановятся по очереди'
    : 'Можно безопасно закрыть приложение через несколько секунд';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 1000000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 24,
        userSelect: 'none',
        pointerEvents: 'all',
      }}
    >
      <div
        className="noted-infinite-animation"
        style={{
          width: 48,
          height: 48,
          border: '3px solid rgba(218, 119, 86, 0.25)',
          borderTopColor: '#DA7756',
          borderRadius: '50%',
          animation: 'shutdown-spin 0.8s linear infinite',
        }}
      />
      <div
        style={{
          color: '#fff',
          fontSize: 15,
          fontWeight: 500,
          letterSpacing: 0.3,
          textAlign: 'center',
          maxWidth: 420,
          lineHeight: 1.5,
        }}
      >
        {message}
      </div>
      <div
        style={{
          color: 'rgba(255,255,255,0.5)',
          fontSize: 12,
          letterSpacing: 0.2,
        }}
      >
        {detail}
      </div>
      <style>{`
        @keyframes shutdown-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
