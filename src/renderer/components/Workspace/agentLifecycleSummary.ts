// What a surface needs to say "this agent is starting / stopping / failed".
//
// Its own file because both directions need it: TerminalArea PRODUCES it, and
// SplitPaneSurface — which TerminalArea itself renders — CONSUMES it. Declaring
// it in TerminalArea would make the pane import its own parent.
export interface AgentLifecycleSummary {
  tabId: string;
  sessionId?: string | null;
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
