import { useEffect, useMemo, useReducer } from 'react';

const { ipcRenderer } = window.require('electron');

interface ComposerImagePreviewRef {
  assetId?: string;
  path?: string;
  availability?: string;
}

export type ComposerImagePreviewVariant = 'thumbnail' | 'detail';

const previewUrls = new Map<string, string>();
const previewErrors = new Map<string, string>();
const previewLoads = new Map<string, Promise<void>>();

export const composerImagePreviewKey = (ref?: ComposerImagePreviewRef) => {
  if (!ref || ref.availability !== 'available') return null;
  const assetId = typeof ref.assetId === 'string' ? ref.assetId.trim() : '';
  if (assetId) return `asset:${assetId}`;
  const filePath = typeof ref.path === 'string' ? ref.path.trim() : '';
  return filePath.startsWith('/') ? `path:${filePath}` : null;
};

const composerImagePreviewCacheKey = (
  ref: ComposerImagePreviewRef | undefined,
  variant: ComposerImagePreviewVariant,
) => {
  const key = composerImagePreviewKey(ref);
  return key ? `${variant}:${key}` : null;
};

const requestComposerImagePreview = (
  ref: ComposerImagePreviewRef,
  variant: ComposerImagePreviewVariant,
) => {
  const key = composerImagePreviewKey(ref);
  const cacheKey = composerImagePreviewCacheKey(ref, variant);
  if (!key || !cacheKey || previewUrls.has(cacheKey) || previewErrors.has(cacheKey)) return Promise.resolve();
  const running = previewLoads.get(cacheKey);
  if (running) return running;
  const request = ipcRenderer.invoke('prompt-queue:get-image-preview-data-url', {
    assetId: ref.assetId,
    path: ref.path,
    variant,
  }).then((result: any) => {
    if (result?.success && typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/')) {
      previewUrls.set(cacheKey, result.dataUrl);
      previewErrors.delete(cacheKey);
      return;
    }
    previewErrors.set(cacheKey, String(result?.error || 'preview_unavailable'));
  }).catch((error: any) => {
    previewErrors.set(cacheKey, String(error?.message || error || 'preview_failed'));
    console.warn('[ComposerImagePreview] load failed:', error?.message || error);
  }).finally(() => {
    previewLoads.delete(cacheKey);
  });
  previewLoads.set(cacheKey, request);
  return request;
};

/**
 * Resolve proven durable attachments through main-process validation.  A
 * data: URL is intentional: the renderer CSP rejects file:// resources, and
 * widening it would expose every local path to renderer markup.
 */
export const useComposerImagePreviews = (
  refs: ComposerImagePreviewRef[],
  variant: ComposerImagePreviewVariant = 'thumbnail',
) => {
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const signature = JSON.stringify(refs.map((ref) => [
    ref.assetId || '',
    ref.path || '',
    ref.availability || '',
  ]));

  useEffect(() => {
    let active = true;
    const missing = refs.filter((ref) => {
      const cacheKey = composerImagePreviewCacheKey(ref, variant);
      return cacheKey && !previewUrls.has(cacheKey) && !previewErrors.has(cacheKey);
    });
    if (missing.length === 0) return undefined;
    void Promise.all(missing.map((ref) => requestComposerImagePreview(ref, variant))).then(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
    };
  // `signature` is the semantic identity; callers often rebuild the array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, variant]);

  return useMemo(() => {
    const resolved = new Map<string, string>();
    for (const ref of refs) {
      const key = composerImagePreviewKey(ref);
      const cacheKey = composerImagePreviewCacheKey(ref, variant);
      if (!key || !cacheKey) continue;
      const url = previewUrls.get(cacheKey);
      if (url) resolved.set(key, url);
    }
    return resolved;
  // `signature` captures the semantic ref list; `revision` captures async IO.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, signature, variant]);
};

export const useComposerImagePreview = (
  ref: ComposerImagePreviewRef | undefined,
  variant: ComposerImagePreviewVariant = 'detail',
) => {
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const signature = JSON.stringify([
    ref?.assetId || '',
    ref?.path || '',
    ref?.availability || '',
    variant,
  ]);
  const key = composerImagePreviewKey(ref);
  const cacheKey = composerImagePreviewCacheKey(ref, variant);

  useEffect(() => {
    if (!ref || !cacheKey || previewUrls.has(cacheKey) || previewErrors.has(cacheKey)) return undefined;
    let active = true;
    void requestComposerImagePreview(ref, variant).then(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
    };
  // `signature` is the complete request identity; the ref object is unstable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const url = cacheKey ? previewUrls.get(cacheKey) : undefined;
  const error = cacheKey ? previewErrors.get(cacheKey) : undefined;
  return useMemo(() => ({
    url,
    error: error || null,
    loading: Boolean(key && !url && !error),
  }), [error, key, revision, url]);
};

export const composerImageUrl = (
  ref: ComposerImagePreviewRef | undefined,
  resolved: ReadonlyMap<string, string>,
) => {
  const key = composerImagePreviewKey(ref);
  return key ? resolved.get(key) : undefined;
};
