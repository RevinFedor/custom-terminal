import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ListTree, RefreshCw, Sparkles } from 'lucide-react';
import Tooltip from '../UI/Tooltip';

// ============================================================================
// Инструменты Timeline — одна кнопка вместо четырёх.
//
// Раньше в тулбаре стояли подряд четыре чипа: «groups», «AI», «tab», «all».
// Они делают близкие вещи (собрать группы всей сессии и обновить пересказы
// пользовательских сообщений, вручную или автоматически), но занимали четверть
// ширины постоянно — при том, что три из четырёх нажимают редко. Подписи при
// этом пришлось сжать до «tab» и «all», по которым не догадаться, что они
// значат: места на объяснение в строке не было.
//
// Теперь это одна кнопка, а по клику вниз раскрывается список. В столбике
// ширина уже не дефицит, поэтому рядом с каждым действием стоит фраза, которая
// его объясняет. Иконки и смысл действий не изменились — изменилось только то,
// сколько места они занимают, пока не нужны.
//
// ВАЖНО: свёрнутый вид не должен скрывать работу, которая идёт прямо сейчас.
// Поэтому на самой кнопке остаются три сигнала: значок групп «дышит», пока их
// собирают; стрелка обновления крутится, пока идут пересказы; кнопка подсвечена,
// пока включён авто-пересказ. Иначе пользователь запустил бы сборку второй раз,
// не увидев первой.
// ============================================================================

type Props = {
  outline: boolean;
  outlineNewCount: number;
  outlineGenerating: boolean;
  outlineDisabled: boolean;
  onGenerateOutline: () => void;
  summaryRunning: boolean;
  summaryDone: number;
  summaryTotal: number;
  summaryDisabled: boolean;
  onRefreshSummaries: () => void;
  summaryTabAuto: boolean;
  /** Глобальный авто включён — настройка вкладки зафиксирована им сверху. */
  summaryTabAutoLocked: boolean;
  onToggleTabAuto: () => void;
  summaryGlobalAuto: boolean;
  onToggleGlobalAuto: () => void;
};

const MENU_WIDTH = 268;

export default function TimelineToolsButton({
  outline,
  outlineNewCount,
  outlineGenerating,
  outlineDisabled,
  onGenerateOutline,
  summaryRunning,
  summaryDone,
  summaryTotal,
  summaryDisabled,
  onRefreshSummaries,
  summaryTabAuto,
  summaryTabAutoLocked,
  onToggleTabAuto,
  summaryGlobalAuto,
  onToggleGlobalAuto,
}: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Закрытие по клику мимо и по Escape. Меню живёт в портале, поэтому «мимо» —
  // это всё, что не кнопка и не сам список; проверяем по DOM-принадлежности, а
  // не по координатам.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Что-то делается прямо сейчас — это видно и на свёрнутой кнопке.
  const busy = outlineGenerating || summaryRunning;
  const active = open || busy || summaryTabAuto || summaryGlobalAuto;

  const triggerStyle: React.CSSProperties = {
    height: 22,
    padding: '0 7px',
    borderRadius: 6,
    border: `1px solid ${active ? 'rgba(192,132,252,0.65)' : 'rgba(255,255,255,0.12)'}`,
    background: active ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)',
    color: active ? '#e9d5ff' : '#a1a1aa',
    fontSize: 10,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  };

  const rowStyle = (disabled: boolean, on: boolean): React.CSSProperties => ({
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: 8,
    padding: '7px 10px',
    border: 0,
    background: on ? 'rgba(168,85,247,0.14)' : 'transparent',
    color: disabled ? '#6b6b70' : (on ? '#e9d5ff' : '#d4d4d8'),
    textAlign: 'left',
    fontSize: 11,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  });

  const hintStyle: React.CSSProperties = {
    gridColumn: '2 / span 2',
    marginTop: 2,
    fontSize: 10,
    lineHeight: 1.35,
    color: '#79797f',
  };

  const rowHover = (event: React.MouseEvent, on: boolean, disabled: boolean) => {
    if (disabled) return;
    (event.currentTarget as HTMLElement).style.background = on
      ? 'rgba(168,85,247,0.2)'
      : 'rgba(255,255,255,0.06)';
  };
  const rowUnhover = (event: React.MouseEvent, on: boolean) => {
    (event.currentTarget as HTMLElement).style.background = on
      ? 'rgba(168,85,247,0.14)'
      : 'transparent';
  };

  // Наведение — как у соседей по шапке. Кнопка со своим цветом состояния
  // (открыта, идёт работа, включён авто) на курсор не отвечает: её подложка
  // уже занята под сообщение о состоянии, и подсветка поверх соврала бы.
  const hoverIn = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (active) return;
    event.currentTarget.style.background = 'rgba(255,255,255,0.10)';
    event.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)';
    event.currentTarget.style.color = '#e4e4e7';
  };
  const hoverOut = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (active) return;
    event.currentTarget.style.background = 'rgba(255,255,255,0.04)';
    event.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
    event.currentTarget.style.color = '#a1a1aa';
  };

  return (
    <>
      <Tooltip content="Инструменты Timeline: группы сессии и пересказы сообщений">
        <button
          ref={buttonRef}
          data-timeline-tools-button
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
          style={triggerStyle}
        >
          <ListTree size={12} className={outlineGenerating ? 'animate-pulse text-purple-300' : ''} />
          {/* Счётчики свёрнутого вида отвечают на «есть ли работа»: сколько
              новых ходов ещё не в группах и сколько пересказов осталось. Оба
              исчезают, когда отвечать нечего. */}
          {summaryRunning
            ? <span style={{ color: '#7dd3fc' }}>{summaryDone}/{summaryTotal}</span>
            : (!outlineGenerating && outlineNewCount > 0
              ? <span style={{ color: '#f0abfc' }}>+{outlineNewCount}</span>
              : null)}
          <ChevronDown
            size={11}
            style={{
              opacity: 0.7,
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.12s ease',
            }}
          />
        </button>
      </Tooltip>

      {open && buttonRef.current && (() => {
        const rect = buttonRef.current.getBoundingClientRect();
        return createPortal(
          <>
            <div
              onMouseDown={() => setOpen(false)}
              onContextMenu={(event) => { event.preventDefault(); setOpen(false); }}
              style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            />
            <div
              data-timeline-tools-menu
              onMouseDown={(event) => event.stopPropagation()}
              style={{
                position: 'fixed',
                top: rect.bottom + 6,
                // Прижато правым краем к кнопке: кнопка стоит в правой половине
                // тулбара, и список, растущий вправо, ушёл бы за окно.
                left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
                width: MENU_WIDTH,
                zIndex: 9999,
                padding: '4px 0',
                background: '#1c1c1f',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
                color: '#ddd',
                userSelect: 'none',
              }}
            >
              <button
                type="button"
                data-timeline-tool="outline"
                disabled={outlineDisabled || outlineGenerating}
                onClick={() => { setOpen(false); void onGenerateOutline(); }}
                onMouseEnter={(event) => rowHover(event, false, outlineDisabled || outlineGenerating)}
                onMouseLeave={(event) => rowUnhover(event, false)}
                style={rowStyle(outlineDisabled || outlineGenerating, false)}
              >
                <ListTree size={13} className={outlineGenerating ? 'animate-pulse text-purple-300' : ''} />
                <span>{outline ? 'Пересобрать группы' : 'Сгруппировать Timeline'}</span>
                {!outlineGenerating && outlineNewCount > 0 && (
                  <span style={{ color: '#f0abfc', fontVariantNumeric: 'tabular-nums' }}>+{outlineNewCount}</span>
                )}
                {outlineGenerating && <span style={{ color: '#c4b5fd' }}>идёт…</span>}
                <span style={hintStyle}>
                  {outlineDisabled
                    ? 'Нужна открытая сессия Claude или Codex'
                    : 'Разбить всю текущую сессию на смысловые группы'}
                </span>
              </button>

              <button
                type="button"
                data-timeline-tool="summaries"
                disabled={summaryDisabled || summaryRunning}
                onClick={() => { setOpen(false); onRefreshSummaries(); }}
                onMouseEnter={(event) => rowHover(event, false, summaryDisabled || summaryRunning)}
                onMouseLeave={(event) => rowUnhover(event, false)}
                style={rowStyle(summaryDisabled || summaryRunning, false)}
              >
                <RefreshCw size={13} className={summaryRunning ? 'animate-spin text-sky-300' : ''} />
                <span>Обновить пересказы</span>
                {summaryRunning && (
                  <span style={{ color: '#7dd3fc', fontVariantNumeric: 'tabular-nums' }}>
                    {summaryDone}/{summaryTotal}
                  </span>
                )}
                <span style={hintStyle}>
                  {summaryDisabled
                    ? 'Нужна открытая сессия Claude или Codex'
                    : 'Пересказать заново все мои сообщения в этой сессии'}
                </span>
              </button>

              <div style={{ height: 1, margin: '4px 0', background: 'rgba(255,255,255,0.08)' }} />

              <button
                type="button"
                data-timeline-tool="auto-tab"
                disabled={summaryDisabled || summaryTabAutoLocked}
                onClick={onToggleTabAuto}
                onMouseEnter={(event) => rowHover(event, summaryTabAuto, summaryDisabled || summaryTabAutoLocked)}
                onMouseLeave={(event) => rowUnhover(event, summaryTabAuto)}
                style={rowStyle(summaryDisabled || summaryTabAutoLocked, summaryTabAuto)}
              >
                <Sparkles size={12} />
                <span>Авто в этой вкладке</span>
                <span style={{ fontSize: 10, color: summaryTabAuto ? '#e9d5ff' : '#6b6b70' }}>
                  {summaryTabAuto ? 'вкл' : 'выкл'}
                </span>
                <span style={hintStyle}>
                  {summaryTabAutoLocked
                    ? 'Включено глобально — здесь уже не переключить'
                    : 'Пересказывать новые сообщения этой вкладки сразу'}
                </span>
              </button>

              <button
                type="button"
                data-timeline-tool="auto-all"
                onClick={onToggleGlobalAuto}
                onMouseEnter={(event) => rowHover(event, summaryGlobalAuto, false)}
                onMouseLeave={(event) => rowUnhover(event, summaryGlobalAuto)}
                style={rowStyle(false, summaryGlobalAuto)}
              >
                <Sparkles size={12} />
                <span>Авто во всех вкладках</span>
                <span style={{ fontSize: 10, color: summaryGlobalAuto ? '#e9d5ff' : '#6b6b70' }}>
                  {summaryGlobalAuto ? 'вкл' : 'выкл'}
                </span>
                <span style={hintStyle}>
                  Пересказывать новые сообщения везде с момента включения
                </span>
              </button>
            </div>
          </>,
          document.body,
        );
      })()}
    </>
  );
}
