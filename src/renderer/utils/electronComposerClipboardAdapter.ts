import type { ClipboardAdapter } from '@gt-editor/markdown-editor';
import { NOTED_COMPOSER_SNAPSHOT_FLAVOR } from './composerClipboard.mjs';

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

/** Copy only an already validated preview data URL; arbitrary file paths stay
 * behind main-process attachment validation. */
export const writeElectronClipboardImageDataUrl = (dataUrl: string): boolean => {
  try {
    if (!dataUrl.startsWith('data:image/')) return false;
    const electron = (window as any).require?.('electron');
    const image = electron?.nativeImage?.createFromDataURL?.(dataUrl);
    if (!image || image.isEmpty?.()) return false;
    electron?.clipboard?.writeImage?.(image);
    return true;
  } catch (cause: any) {
    console.warn('[ComposerClipboard] image copy failed error=' + String(cause?.message || cause));
    return false;
  }
};

export const copyManagedImageToElectronClipboard = async ({
  assetId,
  path,
  fallbackDataUrl,
}: {
  assetId?: string;
  path?: string;
  fallbackDataUrl?: string;
}): Promise<boolean> => {
  try {
    const electron = (window as any).require?.('electron');
    const result = await electron?.ipcRenderer?.invoke?.(
      'prompt-queue:copy-image-to-clipboard',
      { assetId, path },
    );
    if (result?.success === true) return true;
  } catch (cause: any) {
    console.warn('[ComposerClipboard] managed image copy failed error=' + String(cause?.message || cause));
  }
  return fallbackDataUrl ? writeElectronClipboardImageDataUrl(fallbackDataUrl) : false;
};

export const writeElectronComposerSnapshotClipboard = ({
  text,
  snapshot,
}: {
  text: string;
  snapshot: unknown;
}): boolean => {
  const fallback = String(text || '');
  try {
    const electron = (window as any).require?.('electron');
    const target = electron?.clipboard;
    if (!target?.writeText) return false;
    if (!target?.writeBuffer) {
      target.writeText(fallback);
      return false;
    }
    target.clear?.();
    target.writeText(fallback);
    target.writeBuffer(
      NOTED_COMPOSER_SNAPSHOT_FLAVOR,
      Buffer.from(JSON.stringify(snapshot), 'utf8'),
    );
    return true;
  } catch (cause: any) {
    console.warn('[ComposerClipboard] snapshot write failed error=' + String(cause?.message || cause));
    resolveElectronClipboard()?.writeText(fallback);
    return false;
  }
};

export const readElectronComposerSnapshotClipboard = (): unknown | null => {
  try {
    const electron = (window as any).require?.('electron');
    const target = electron?.clipboard;
    const formats = target?.availableFormats?.() || [];
    if (!formats.includes(NOTED_COMPOSER_SNAPSHOT_FLAVOR)) return null;
    const buffer = target.readBuffer?.(NOTED_COMPOSER_SNAPSHOT_FLAVOR);
    if (!buffer || buffer.length === 0) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch (cause: any) {
    console.warn('[ComposerClipboard] snapshot read failed error=' + String(cause?.message || cause));
    return null;
  }
};
