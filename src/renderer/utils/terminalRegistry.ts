import { Terminal as XTerminal } from '@xterm/xterm';

// Global registry to access terminal instances from anywhere
const terminals = new Map<string, XTerminal>();

export const terminalRegistry = {
  register(tabId: string, terminal: XTerminal) {
    terminals.set(tabId, terminal);
  },

  unregister(tabId: string) {
    terminals.delete(tabId);
  },

  get(tabId: string): XTerminal | undefined {
    return terminals.get(tabId);
  },

  getSelection(tabId: string): string {
    const terminal = terminals.get(tabId);
    if (!terminal) return '';
    return terminal.getSelection() || '';
  },

  hasSelection(tabId: string): boolean {
    const terminal = terminals.get(tabId);
    if (!terminal) return false;
    return terminal.hasSelection();
  }
};
