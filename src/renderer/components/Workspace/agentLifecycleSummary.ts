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
  kind: 'starting' | 'stopping' | 'interrupted' | 'error';
  title: string;
  description: string;
  detail?: string | null;
  spinner: boolean;
  dismissLabel?: string;
  onDismiss?: () => void;
  retryLabel?: string;
  onRetry?: () => void;
}
