import React from 'react';
import { Bot, SquareTerminal } from 'lucide-react';
import { useUIStore, resolveTabTerminalPrimary } from '../../store/useUIStore';
import ControlHint from '../UI/ControlHint';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {RIGHT_CLUSTER_INNER_GAP_PX} from '../../utils/controlBarWrap.mjs';

/** The existing stationary queue/composer host stays above the side terminal.
 * A scalar presentation guard also quarantines retained hidden owners. */
export function StationaryHistorySurfaceToggle({tabId}: {tabId:string}) {
  const presented=useWorkspaceStore(state=>state.view==='workspace'&&(state.splitPanes.length
    ?state.splitPanes.some(pane=>!pane.displayHidden&&pane.tabId===tabId)
    :state.getEffectiveTabId()===tabId));
  const padding=useUIStore(state=>state.historyHorizontalPadding);
  if(!presented)return null;
  return <div data-history-side-surface-toggle data-history-side-surface-stationary
    style={{position:'absolute',bottom:RIGHT_CLUSTER_INNER_GAP_PX,right:padding,zIndex:10,pointerEvents:'auto'}}
    onMouseDown={event=>event.stopPropagation()}>
    <SideSurfaceToggleButton tabId={tabId} size={28}/>
  </div>;
}

/**
 * «Выдвинуть/скрыть вторую поверхность» — рядом со стрелкой вниз, над полем
 * ввода, у правого края.
 *
 * Раньше кнопка жила только в рейле Run after, справа сбоку. Место у поля ввода
 * ближе к тому, чем пользуются: раскладку меняют, не отрывая руки от набора.
 *
 * ОДИН компонент на две поверхности намеренно. Кнопка нужна и над полем History,
 * и над полем терминала, а состояний у неё два и они зеркальны: если в центре
 * AI-чат — выдвигается терминал, если в центре терминал — выдвигается чат. Две
 * копии этой развилки разошлись бы при первой же правке, и одна из поверхностей
 * тихо осталась бы с прежним поведением.
 *
 * Размер задан снаружи (`size`), потому что стрелки вниз у History и терминала
 * исторически разной величины, а кнопка обязана совпадать с соседкой — иначе
 * пара читается как два несвязанных элемента.
 */
/**
 * Доля кнопки, которую занимает значок.
 *
 * Взята с соседней стрелки вниз: 16px значка в 28px квадрате ≈ 0.57. Это и есть
 * «отмасштабировать нормально» — при переносе кнопки менялся размер квадрата, и
 * значок обязан был вырасти вместе с ним. Раньше здесь стояло 0.5, что при 28px
 * даёт 14px — ровно тот же значок, что был в рейле в квадрате 21px. Снаружи это
 * читалось как «увеличил только фон»: пустого поля вокруг значка стало вдвое
 * больше, а сам значок остался прежним (юзер: «какого хуя это размер оставил
 * такой же, добавил просто пустой бэкграунд»).
 */
const SIDE_SURFACE_GLYPH_RATIO = 16 / 28;

export default function SideSurfaceToggleButton({
  tabId,
  size = 28,
}: {
  tabId: string;
  size?: number;
}) {
  const terminalIsPrimary = useUIStore((s) => resolveTabTerminalPrimary(s, tabId));
  const sideTerminalOpen = useUIStore((s) => s.sideTerminalOpenTabs[tabId] ?? false);
  const historyPanelOpen = useUIStore((s) => s.historyPanelOpenTabs[tabId] ?? false);
  // Что именно «открыто», зависит от того, какая поверхность в центре: в
  // terminal-primary второй поверхностью является сам транскрипт.
  const secondaryOpen = terminalIsPrimary ? historyPanelOpen : sideTerminalOpen;

  const toggle = React.useCallback(() => {
    // Читаем состояние в момент клика, а не из замыкания: реверс мог произойти
    // между рендером и нажатием, и тогда мы переключили бы не ту поверхность.
    const state = useUIStore.getState();
    if (resolveTabTerminalPrimary(state, tabId)) {
      state.setHistoryPanelOpen(tabId, !(state.historyPanelOpenTabs[tabId] ?? false));
      return;
    }
    state.setSideTerminalOpen(tabId, !(state.sideTerminalOpenTabs[tabId] ?? false));
  }, [tabId]);

  const surfaceName = terminalIsPrimary ? 'AI-чат' : 'терминал';
  // Иконка называет ВЫДВИГАЕМУЮ поверхность, поэтому меняется вместе с центром:
  // это единственное, что в кнопке зависит от раскладки, и здесь так и надо —
  // сам жест меняет смысл.
  const Icon = terminalIsPrimary ? Bot : SquareTerminal;

  return (
    <ControlHint label={(secondaryOpen ? 'Скрыть ' : 'Выдвинуть ') + surfaceName}>
      <button
        type="button"
        data-side-surface-toggle={terminalIsPrimary ? 'chat' : 'terminal'}
        aria-label={terminalIsPrimary ? 'Toggle side chat' : 'Toggle side terminal'}
        aria-pressed={secondaryOpen}
        onClick={toggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          padding: 0,
          borderRadius: 6,
          // Тот же вид, что у стрелки вниз рядом: пара над полем должна читаться
          // как один блок из двух кнопок, а не как два разных элемента.
          backgroundColor: secondaryOpen ? '#2b2340' : '#323237',
          border: '1px solid ' + (secondaryOpen ? 'rgba(167, 139, 250, 0.75)' : 'rgba(167, 139, 250, 0.3)'),
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
          color: secondaryOpen ? '#c4b5fd' : '#a78bfa',
          cursor: 'pointer',
          transition: 'background-color 0.12s, border-color 0.12s, color 0.12s',
        }}
      >
        <Icon size={Math.round(size * SIDE_SURFACE_GLYPH_RATIO)} strokeWidth={2.1} />
      </button>
    </ControlHint>
  );
}
