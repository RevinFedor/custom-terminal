/* ============================================================
   @noted/claude-blocks — нормализованная форма сообщения чата
   ------------------------------------------------------------
   Единая data-shape для ВСЕХ потребителей (десктоп SDK, мобила,
   gt-editor). Десктоп исторически runtime-driven (assistant-ui
   MessagePrimitive), мобила data-driven (UiEntry). Чтобы «весь чат»
   переносился, презентационные компоненты пакета читают именно
   ЭТУ форму — каждый потребитель нормализует свой источник
   (assistant-ui message / JSONL entry / Gemini turn) в ChatEntry.

   Под капотом lifecycle (SDK/Gemini/API, kill/resume, JSONL) — НЕ
   дело пакета. Пакет рисует расположение и содержимое, не управляет
   процессом. Поведение (раскрытие, скролл, действия) — внедряется.
   ============================================================ */
import type React from 'react';
import type { DiffHunk } from './helpers';

/** Метрики compact-summary (оранжевая карточка). */
export interface CompactMetrics {
  preTokens: number;
  postTokens: number;
  durationMs: number;
  trigger?: string;
}

/** Нормализованная запись чата — superset мобильного UiEntry. */
export type ChatEntry =
  | { kind: 'user'; id: string; text: string; entryUuid?: string; wasQueued?: boolean }
  | { kind: 'assistant'; id: string; text: string; entryUuid?: string; stopped?: boolean; durationMs?: number }
  | { kind: 'thinking'; id: string; text: string; entryUuid?: string; label?: string }
  | { kind: 'tool'; id: string; tool: string; input?: any; result?: string; isError?: boolean; entryUuid?: string; startLine?: number; diffHunks?: readonly DiffHunk[]; awaitingApproval?: boolean }
  | { kind: 'slash'; id: string; text: string; entryUuid?: string }
  | { kind: 'compact-summary'; id: string; text: string; entryUuid?: string; metrics?: CompactMetrics }
  | { kind: 'system'; id: string; text: string; entryUuid?: string }
  | { kind: 'error'; id: string; text: string; entryUuid?: string };

export type ChatEntryKind = ChatEntry['kind'];

/** Управление раскрытием — внедряется потребителем (scroll-stable у
 *  десктопа внутри Virtuoso, module-Map персист у мобилы). Пакет вызывает
 *  toggle(); если контроллер не передан — компонент держит локальный
 *  useState (голый потребитель / gt-editor по умолчанию). */
export interface CollapseController {
  /** Текущее состояние раскрытия для записи по id. */
  isOpen: (id: string, defaultOpen: boolean) => boolean;
  /** Тоггл раскрытия записи. Потребитель оборачивает в свою scroll-логику. */
  toggle: (id: string, next: boolean) => void;
}

/** Колбэки действий над сообщением (copy/repeat/edit). Если не переданы —
 *  соответствующая кнопка не рендерится. Видимость самой панели — actions. */
export interface MessageActions {
  /** Копировать текст ответа ассистента. */
  onCopy?: (entry: ChatEntry) => void;
  /** Повторить user-сообщение (drop replies, resend). */
  onRepeat?: (entry: ChatEntry) => void;
  /** Редактировать user-сообщение. */
  onEdit?: (entry: ChatEntry) => void;
}

/** Контекст рендера одного сообщения — прокидывается из ChatTranscript. */
export interface ChatRenderContext {
  collapse?: CollapseController;
  actions?: MessageActions;
  /** Десктопу нужен ref-якорь на корень раскрываемого блока для
   *  scroll-compensation. Фабрика возвращает ref на запись по id. */
  anchorRefFor?: (id: string) => React.RefObject<HTMLDivElement | null> | undefined;
}
