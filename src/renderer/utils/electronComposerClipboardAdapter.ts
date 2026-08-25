import type { ClipboardAdapter } from '@gt-editor/markdown-editor';
import { NOTED_COMPOSER_SNAPSHOT_FLAVOR } from './composerClipboard.mjs';

const NOTED_COMPOSER_SNAPSHOT_HTML_ATTR = 'data-noted-terminal-composer-snapshot';

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

export interface ElectronComposerSnapshotWriteResult {
  textCopied: boolean;
  snapshotCopied: boolean;
}

const escapeClipboardHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const snapshotFromClipboardHtml = (html: string): unknown | null => {
  const match = String(html || '').match(new RegExp(
    `${NOTED_COMPOSER_SNAPSHOT_HTML_ATTR}\\s*=\\s*["']([A-Za-z0-9+/=]+)["']`,
    'i',
  ));
  if (!match?.[1]) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

export const writeElectronComposerSnapshotClipboard = ({
  text,
  snapshot,
}: {
  text: string;
  snapshot: unknown;
}): ElectronComposerSnapshotWriteResult => {
  const fallback = String(text || '');
  try {
    const electron = (window as any).require?.('electron');
    const target = electron?.clipboard;
    if (!target?.writeText) return { textCopied: false, snapshotCopied: false };
    if (!target?.write) {
      target.writeText(fallback);
      return { textCopied: target.readText?.() === fallback, snapshotCopied: false };
    }
    const encodedSnapshot = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64');
    const html = '<span style="display:none" '
      + NOTED_COMPOSER_SNAPSHOT_HTML_ATTR + '="' + encodedSnapshot + '"></span>'
      + '<pre style="white-space:pre-wrap">' + escapeClipboardHtml(fallback) + '</pre>';

    // One atomic native item is essential on macOS. Sequential writeText →
    // writeBuffer replaced the standard text representation with our custom
    // flavor, so Cmd+V produced a keydown but NO paste event at all.
    target.clear?.();
    target.write({ text: fallback, html });
    const textCopied = target.readText?.() === fallback;
    const snapshotCopied = snapshotFromClipboardHtml(target.readHTML?.() || '') !== null;
    console.log('[ComposerClipboard] snapshot-write text=' + (textCopied ? '1' : '0')
      + ' snapshot=' + (snapshotCopied ? '1' : '0')
      + ' formats=' + (target.availableFormats?.() || []).join(','));
    if (textCopied && snapshotCopied) return { textCopied, snapshotCopied };

    // Never leave a clipboard that cannot paste anything while showing a
    // success toast. Plain text is the honest portable fallback.
    target.writeText(fallback);
    return {
      textCopied: target.readText?.() === fallback,
      snapshotCopied: false,
    };
  } catch (cause: any) {
    console.warn('[ComposerClipboard] snapshot write failed error=' + String(cause?.message || cause));
    const target = resolveElectronClipboard();
    target?.writeText(fallback);
    return {
      textCopied: target?.readText() === fallback,
      snapshotCopied: false,
    };
  }
};

export const readElectronComposerSnapshotClipboard = (): unknown | null => {
  try {
    const electron = (window as any).require?.('electron');
    const target = electron?.clipboard;
    const htmlSnapshot = snapshotFromClipboardHtml(target?.readHTML?.() || '');
    if (htmlSnapshot !== null) return htmlSnapshot;

    // Compatibility with clipboard contents produced by older builds. New
    // writes use one atomic text+HTML item because writeBuffer alone is not a
    // pasteable macOS representation.
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
