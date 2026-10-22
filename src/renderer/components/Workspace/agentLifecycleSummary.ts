// What a surface needs to say "this agent is starting / stopping / failed".
//
// Its own file because both directions need it: TerminalArea PRODUCES it, and
// SplitPaneSurface — which TerminalArea itself renders — CONSUMES it. Declaring
// it in TerminalArea would make the pane import its own parent.
export interface AgentLifecycleSummary {
  tabId: string;
  sessionId?: string | null;
  /**
   * Который агент. Поле явное, потому что «продолжить прерванную сессию» должно
   * знать движок, а вытаскивать его из заголовка (`title.startsWith('CODEX')`)
   * — значит связать поведение с текстом подписи: перевод или правка формулировки
   * молча сломали бы возобновление.
   */
  engine?: 'claude' | 'codex';
  // 'interrupted' удалён (2026-09-11): wasInterrupted-маркер больше не имеет
  // собственной плашки/цвета — вкладка с прерванной сессией выглядит просто
  // неактивной, ошибки автозапуска показываются тостом из AutoResume.
  kind: 'starting' | 'stopping' | 'info' | 'warning' | 'error';
  title: string;
  description: string;
  detail?: string | null;
  copyText?: string;
  spinner: boolean;
  dismissLabel?: string;
  onDismiss?: () => void;
  retryLabel?: string;
  onRetry?: () => void;
  goalOperationId?: string;
  goalControlsBlocked?: boolean;
  goalStartupPending?: boolean;
  goalActions?: {
    operationId: string;
    availableActions: Array<'resume' | 'leave-paused'>;
    pendingAction?: 'resume' | 'leave-paused' | null;
    onChoose?: (action: 'resume' | 'leave-paused') => void;
  };
}
