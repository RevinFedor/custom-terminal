import React, { useEffect, useState } from 'react';

const { ipcRenderer } = window.require('electron');

type ShutdownOverlayState = {
  show: boolean;
  tabsCount?: number;
  closedTabs?: number;
  cancellable?: boolean;
  cancelling?: boolean;
};

/**
 * Экран закрытия приложения — и единственная возможность передумать.
 *
 * Закрытие не мгновенное: приложение по очереди просит каждую живую AI-сессию
 * завершиться (Ctrl+C), и на большом рабочем пространстве это занимает секунды.
 * Всё это время пользователь смотрит на экран, который раньше только сообщал,
 * что уже ничего не поделать — хотя остановлены ещё не все вкладки.
 *
 * Поэтому здесь кнопка «Отмена». Она честна насчёт того, что умеет:
 *
 *   ┌───────────────────────────────────────────┐
 *   │              ◜◝ (крутится)                 │
 *   │     Сохраняю 7 активных AI-сессий…        │
 *   │          Остановлено 3 из 7               │  ← растёт по ходу
 *   │                                           │
 *   │              [  Отмена  ]                 │  ← пока не закрылась последняя
 *   │   Уже остановленные сессии не вернутся    │
 *   └───────────────────────────────────────────┘
 *
 * Нажатие НЕ требует подтверждения: пользователь уже выбрал, нажимая. Главный
 * процесс проверяет отмену перед каждой следующей вкладкой, поэтому
 * невыключенные остаются работать, а те, что уже получили Ctrl+C, при
 * следующем запуске честно отмечены прерванными.
 *
 * Кнопки нет, когда закрытие принадлежит установщику (`cancellable:false`):
 * build:i-c сам перезапустит приложение, и отмена оставила бы его без цели.
 */
export default function ShutdownOverlay() {
  const [visible, setVisible] = useState(false);
  const [tabsCount, setTabsCount] = useState(0);
  const [closedTabs, setClosedTabs] = useState(0);
  const [cancellable, setCancellable] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const handler = (_e: any, payload: ShutdownOverlayState) => {
      if (!payload.show) {
        setVisible(false);
        setCancelling(false);
        setClosedTabs(0);
        return;
      }
      // Главный процесс шлёт прогресс отдельными кадрами, и у кадра «отменяю»
      // нет остальных полей. Обновляем только то, что действительно пришло,
      // иначе счётчик обнулялся бы на каждом таком кадре.
      if (typeof payload.tabsCount === 'number') setTabsCount(payload.tabsCount);
      if (typeof payload.closedTabs === 'number') setClosedTabs(payload.closedTabs);
      if (typeof payload.cancellable === 'boolean') setCancellable(payload.cancellable);
      if (payload.cancelling) setCancelling(true);
      setVisible(true);
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

  // Отмена возможна, пока остановлены не все: когда закрылась последняя
  // вкладка, возвращать уже нечего.
  const canCancel = cancellable && !cancelling && (tabsCount === 0 || closedTabs < tabsCount);

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
      {tabsCount > 0 && (
        // Статичная подпись в верхнем регистре рядом с живым счётчиком: она
        // читается и на видеозаписи, где анимация спиннера съедается кодеком.
        <div
          data-shutdown-progress
          style={{
            color: 'rgba(255,255,255,0.75)',
            fontSize: 12,
            letterSpacing: 0.6,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ОСТАНОВЛЕНО {closedTabs} ИЗ {tabsCount}
        </div>
      )}
      <div
        style={{
          color: 'rgba(255,255,255,0.5)',
          fontSize: 12,
          letterSpacing: 0.2,
        }}
      >
        {detail}
      </div>
      {cancellable && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            data-shutdown-cancel
            disabled={!canCancel}
            // Без подтверждения: пользователь уже выбрал, нажимая. Второй
            // вопрос здесь стоил бы ровно тех секунд, которые и решают,
            // успеет ли отмена спасти оставшиеся вкладки.
            onClick={() => { setCancelling(true); ipcRenderer.send('shutdown:cancel'); }}
            style={{
              padding: '7px 22px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: 0.3,
              color: canCancel ? '#fff' : 'rgba(255,255,255,0.45)',
              backgroundColor: canCancel ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)',
              border: '1px solid ' + (canCancel ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)'),
              // Системный волчок macOS накрыл бы всё окно и читался бы как
              // «приложение зависло» — ровно то, чего этот экран избегает.
              cursor: canCancel ? 'pointer' : 'default',
              transition: 'background-color 0.12s, border-color 0.12s, color 0.12s',
            }}
          >
            {cancelling ? 'Отменяю…' : 'Отмена'}
          </button>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, letterSpacing: 0.2 }}>
            {cancelling
              ? 'Оставшиеся сессии продолжат работу'
              : 'Уже остановленные сессии отмена не вернёт'}
          </div>
        </div>
      )}
      <style>{`
        @keyframes shutdown-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
