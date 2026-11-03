import React from 'react';
import ControlHint from '../UI/ControlHint';

/**
 * «В конец» — ОДНА кнопка на все поверхности: центральный транскрипт, боковая
 * панель History и терминал (в центре и сбоку).
 *
 * Раньше это были три независимых куска разметки, и они разошлись ровно так,
 * как расходится скопированный стиль: у терминала — полупрозрачный серый фон
 * (`rgba(60,60,60,.85)`), белый символ `↓` текстом и своя подсветка по наведению,
 * у History — тёмно-серый `#323237` с фиолетовым значком. На тёмном фоне
 * приложения серый вариант почти не отличался от подложки: пользователь видел
 * «серый квадратик с чёрточкой» рядом с яркой фиолетовой кнопкой раскладки и
 * читал их как два разных по важности элемента.
 *
 * Поэтому здесь закреплены три вещи, которые не должны снова разъехаться:
 *
 *  1) ВИД. Фон контрастирует с подложкой приложения, а не повторяет её; цвет
 *     значка — та же фиолетовая палитра, что у соседней кнопки раскладки, так
 *     что пара читается как один блок.
 *  2) ЗНАЧОК. Полноценная стрелка (черта + наконечник), а не один шеврон:
 *     шеврон в 28px квадрате выглядит как короткая чёрточка.
 *  3) ГЕОМЕТРИЯ. Размер и радиус те же, что у `SideSurfaceToggleButton`, и
 *     значок центрирован — его рисует сетка `place-items`, а не пробел в тексте.
 *
 * Где именно стоит кнопка, решает вызывающая сторона: у центра она по центру
 * поверхности, в боковой панели и терминале — у правого края. Здесь только то,
 * как она выглядит и что делает.
 */

/** Сторона квадрата. Совпадает с `SideSurfaceToggleButton`: они стоят парой. */
export const SCROLL_TO_BOTTOM_SIZE_PX = 28;

/** Доля квадрата под значок — та же пропорция, что у кнопки раскладки. */
const GLYPH_RATIO = 16 / 28;

const BACKGROUND = '#2b2340';
const BACKGROUND_HOVER = '#3b2f58';
const BORDER = 'rgba(167, 139, 250, 0.55)';
const BORDER_HOVER = 'rgba(196, 181, 253, 0.9)';
const GLYPH = '#c4b5fd';
const GLYPH_HOVER = '#ddd6fe';

/**
 * Стрелка вниз: вертикальная черта + наконечник.
 *
 * Не `ChevronDown` из lucide: это только наконечник, и в маленьком квадрате
 * он читается как чёрточка — именно на это и пожаловался пользователь. Здесь
 * `currentColor`, поэтому цвет задаёт кнопка и состояние наведения работает
 * без второго писателя стиля.
 */
export function ArrowToBottomGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path d="M12 4.5v12.5" />
      <path d="M6 12.5 12 19l6-6.5" />
    </svg>
  );
}

export default function ScrollToBottomButton({
  size = SCROLL_TO_BOTTOM_SIZE_PX,
  label = 'Прокрутить вниз',
  ...rest
}: {
  size?: number;
  label?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { style, onMouseEnter, onMouseLeave, ...buttonProps } = rest;
  return (
    <ControlHint label={label}>
      <button
        type="button"
        {...buttonProps}
        style={{
          // `grid` + `place-items` центрирует значок по обеим осям независимо
          // от того, какой line-height достался кнопке от родителя. Прежний
          // терминальный вариант рисовал символ `↓` текстом, и его базовая
          // линия сажала стрелку ниже центра квадрата.
          display: 'grid',
          placeItems: 'center',
          width: size,
          height: size,
          padding: 0,
          borderRadius: 6,
          backgroundColor: BACKGROUND,
          border: '1px solid ' + BORDER,
          color: GLYPH,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
          cursor: 'pointer',
          transition: 'background-color 0.12s, border-color 0.12s, color 0.12s',
          ...style,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.backgroundColor = BACKGROUND_HOVER;
          event.currentTarget.style.borderColor = BORDER_HOVER;
          event.currentTarget.style.color = GLYPH_HOVER;
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.backgroundColor = BACKGROUND;
          event.currentTarget.style.borderColor = BORDER;
          event.currentTarget.style.color = GLYPH;
          onMouseLeave?.(event);
        }}
      >
        <ArrowToBottomGlyph size={Math.round(size * GLYPH_RATIO)} />
      </button>
    </ControlHint>
  );
}
