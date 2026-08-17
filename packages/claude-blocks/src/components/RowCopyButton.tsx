/* ============================================================
   @noted/claude-blocks — RowCopyButton
   ------------------------------------------------------------
   Кнопка «копировать» для раскрываемой строки ленты (tool-карточка,
   thinking). Копирование НЕ выполняется пакетом: буфер обмена — дело
   хоста (Electron clipboard vs navigator.clipboard в браузере), поэтому
   наружу отдаётся только текст через onCopy.
   ============================================================ */
import React, { useEffect, useRef, useState } from 'react';
import { CopyIcon, CheckIcon } from '../icons';

export interface RowCopyButtonProps {
  /**
   * The row's FULL payload, in its original form — resolved lazily so a
   * collapsed row never pays for building a string nobody asked for.
   * Returning an empty string renders nothing (there is nothing to copy).
   */
  getText: () => string;
  /** Host clipboard write. */
  onCopy: (text: string) => void;
  title?: string;
}

/**
 * Same affordance the user already knows from a prompt row: appears on hover
 * at the row's right edge, copies the whole thing.
 *
 * "The whole thing" is deliberately the row's OWN payload, not what is on
 * screen: reasoning copies its full text even while collapsed, a Read copies
 * the file content it shows when expanded, a Bash copies command + output.
 * The alternative — copy only what is currently visible — would make the
 * result depend on a toggle the user may not even have touched.
 */
export const RowCopyButton: React.FC<RowCopyButtonProps> = ({ getText, onCopy, title }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  return (
    <button
      type="button"
      className="cb-row-copy"
      aria-label={title || 'Скопировать содержимое'}
      title={title || 'Скопировать содержимое'}
      // The row header is itself a button/toggle — without this the copy
      // click would also expand or collapse the row it belongs to.
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const text = getText();
        if (!text) return;
        onCopy(text);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setCopied(false);
        }, 900);
      }}
    >
      {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
    </button>
  );
};
