import type { ClipboardAdapter } from '@gt-editor/markdown-editor';

type ElectronClipboard = {
  readText: () => string;
  writeText: (text: string) => void;
  availableFormats: () => string[];
};

const resolveElectronClipboard = (): ElectronClipboard | null => {
  try {
    return (window as any).require?.('electron')?.clipboard || null;
  } catch (cause: any) {
    console.warn('[ComposerClipboard] electron clipboard unavailable error=' + String(cause?.message || cause));
    return null;
  }
};

/**
 * One stable adapter for every lightweight AI composer. `readItems` stays
 * intentionally absent: image bytes continue through the trusted native paste
 * event, while Electron supplies deterministic text and custom-format reads.
 */
export const electronComposerClipboardAdapter: ClipboardAdapter = {
  readText: () => resolveElectronClipboard()?.readText() || '',
  writeText: (text: string) => resolveElectronClipboard()?.writeText(text),
  readFormats: () => resolveElectronClipboard()?.availableFormats() || [],
};
