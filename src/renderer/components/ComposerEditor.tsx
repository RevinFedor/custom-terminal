import { forwardRef, useCallback, useLayoutEffect, useRef } from 'react';
import { ComposerEditor as SharedComposerEditor, type ComposerEditorHandle, type ComposerEditorProps } from '@gt-editor/markdown-editor';
import { observeDictationComposerPaste, registerDictationComposer } from '../utils/dictationEditableClipboard.mjs';

// Host adapter for every Noted ComposerEditor. The shared editor keeps ownership
// of paste, history and token sidecars; this only proves its exact document edit
// to the existing Voice clipboard receipt protocol.
export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(props, forwardedRef) {
  const handleRef = useRef<ComposerEditorHandle | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const setHandle = useCallback((handle: ComposerEditorHandle | null) => {
    handleRef.current = handle;
    if (typeof forwardedRef === 'function') forwardedRef(handle);
    else if (forwardedRef) forwardedRef.current = handle;
  }, [forwardedRef]);

  useLayoutEffect(() => {
    const handle = handleRef.current;
    const content = handle?.dom?.querySelector<HTMLElement>('.cm-content');
    if (!handle || !content) return;
    return registerDictationComposer(content, {
      ownerKey: () => JSON.stringify([propsRef.current.historyOwnerKey || '',
        content.closest('[data-dictation-owner-key]')?.getAttribute('data-dictation-owner-key') || '']),
      readOnly: () => propsRef.current.readOnly === true,
      value: () => handle.value,
      selection: () => ({ start: handle.selectionStart, end: handle.selectionEnd }),
    });
  }, [props.historyOwnerKey, props.readOnly]);

  return <SharedComposerEditor {...props} ref={setHandle} onPaste={(event) => {
    const content = handleRef.current?.dom?.querySelector<HTMLElement>('.cm-content');
    if (content) observeDictationComposerPaste(content, event);
    if (!(event.nativeEvent || event).defaultPrevented) propsRef.current.onPaste?.(event);
  }} />;
});
