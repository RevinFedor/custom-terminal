// Страница выбора «Новая вкладка» — тело окна, пока вкладки в нём ещё нет.
//
// Отвечает ровно на один вопрос: чем начать. Кнопки — ТА ЖЕ полоса запуска
// (`AiLaunchStrip`), что стоит в баре новой вкладки и в шапке пустого окна:
// один компонент, не копия. Второй набор кнопок «которые просто запускают то
// же самое» разошёлся бы с настоящим на первом же изменении правил запуска —
// это тот же довод, по которому полоса уже была объединена однажды.
//
// Что принадлежит ЭТОМУ файлу: как выглядит страница и какой адрес у ответа.
// Куда приземляется запуск — дело стора: он держит адрес заготовки и создаёт
// вкладку существующим путём. Поэтому здесь нет ни `createTab`, ни IPC.

import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import {
  getWindowChooserLaunchAction,
  subscribeWindowChooserLaunch,
  useWorkspaceStore,
  type WindowChooserLaunchAction,
} from '../../store/useWorkspaceStore';
import AiLaunchStrip, { type AiLaunchAction } from './AiLaunchStrip';

export interface PaneChooserPageProps {
  slotId: string;
  paneIndex: number;
}

export default function PaneChooserPage({ slotId, paneIndex }: PaneChooserPageProps) {
  // Страница может исчезнуть и вернуться посреди запуска. Подписка на саму
  // операцию сохраняет и её loader, и выбранного агента; проигнорированный
  // второй клик не меняет этот ответ и не гасит первый loader.
  const subscribe = React.useCallback(
    (listener: () => void) => subscribeWindowChooserLaunch(slotId, listener),
    [slotId],
  );
  const getSnapshot = React.useCallback(() => getWindowChooserLaunchAction(slotId), [slotId]);
  const busyAction = React.useSyncExternalStore(subscribe, getSnapshot, () => null);

  const launch = React.useCallback(async (action: AiLaunchAction) => {
    try {
      await useWorkspaceStore.getState().createTabForWindowChooser(
        slotId,
        action as WindowChooserLaunchAction,
      );
    } catch (error: any) {
      // Отклонённый Promise обязан оставить видимый след: молчаливый `finally`
      // просто вернул бы кнопки, и человек не узнал бы, почему ничего не
      // произошло.
      console.error('[PaneChooserPage] launch failed slot=' + slotId
        + ' action=' + action + ' error=' + (error?.message || error));
      useUIStore.getState().showToast(
        'Не удалось создать вкладку: ' + (error?.message || 'неизвестная ошибка'),
        'error',
      );
    }
  }, [slotId]);

  return (
    <div
      data-pane-chooser-page
      data-chooser-slot-id={slotId}
      data-pane-index={paneIndex}
      // Двойной клик по телу — это про ЭТУ страницу, а не «ещё одно место».
      // Без остановки он дошёл бы до общего обработчика пустого окна и открыл
      // бы вторую заготовку под пальцем человека, который целился в кнопки.
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 16,
        pointerEvents: 'auto',
        userSelect: 'none',
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        <AiLaunchStrip
          // Ведущий чип «Claude» рисует сама полоса: живой сессии здесь нет, а
          // значит нет и её отдельной кнопки управления, рядом с которой этот
          // чип оказался бы вторым.
          ownsClaudeChip
          // «Терминал» — законный ответ на вопрос «каким агентом начать»:
          // никаким. Без него shell-вкладку нельзя было бы получить вовсе,
          // потому что двойной клик теперь открывает как раз эту страницу.
          showTerminal
          isBusy={(action) => busyAction === action}
          onLaunch={(action) => { void launch(action); }}
        />
      </div>
      <div style={{ color: '#5f5f65', fontSize: 11.5 }}>
        Выберите, чем начать · Ctrl+Tab / Cmd+P или клик по вкладке слева
      </div>
    </div>
  );
}
