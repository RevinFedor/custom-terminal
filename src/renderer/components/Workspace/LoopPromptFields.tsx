import type { Ref } from 'react';
import type { ComposerEditorHandle } from '@gt-editor/markdown-editor';
import { ComposerEditor } from '../ComposerEditor';
import { electronComposerClipboardAdapter } from '../../utils/electronComposerClipboardAdapter';

type Props = {
  tabId: string;
  sharedText: string;
  localText: string;
  height: number;
  fontSize: number;
  autoFocus: boolean;
  sharedRef: Ref<ComposerEditorHandle>;
  onSharedChange: (text: string) => void;
  onLocalChange: (text: string) => void;
  onSave: () => void;
  onClose: () => void;
};

// The two labelled, independently scrolling fields share the old editor budget.
// Both use the host Composer adapter (paste/undo/dictation receipt ownership).
export function LoopPromptFields(props: Props) {
  return <div data-loop-prompt-fields style={{ height: props.height, maxHeight: '100%',
    display: 'grid', gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8, padding: 8, boxSizing: 'border-box' }}>
    {(['shared', 'local'] as const).map(scope => <section key={scope} data-loop-prompt-scope={scope}
      aria-label={scope === 'shared' ? 'Общий для всех вкладок' : 'Только для этой вкладки'}
      style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid #414141',
        borderRadius: 6, background: '#131313', overflow: 'hidden' }}>
      <div style={{ flex: '0 0 24px', padding: '0 9px', display: 'flex', alignItems: 'center',
        fontSize: Math.max(10, props.fontSize - 1), color: '#bbb', fontWeight: 600, background: '#222' }}>
        {scope === 'shared' ? 'Общий для всех вкладок' : 'Только для этой вкладки'}
      </div>
      <ComposerEditor ref={scope === 'shared' ? props.sharedRef : undefined}
        autoFocus={scope === 'shared' && props.autoFocus}
        value={scope === 'shared' ? props.sharedText : props.localText}
        placeholder={scope === 'local' ? 'Дополнительные инструкции для этой вкладки' : 'Общие инструкции Loop'}
        historyOwnerKey={scope === 'shared' ? 'run-after:loop:shared' : `run-after:${props.tabId}:loop:local`}
        fontSize={props.fontSize} clipboard={electronComposerClipboardAdapter}
        onChange={text => scope === 'shared' ? props.onSharedChange(text) : props.onLocalChange(text)}
        onKeyDown={event => {
          if (event.key === 'Escape') props.onClose();
          if (event.key === 'Enter' && event.metaKey) { event.preventDefault(); event.stopPropagation(); props.onSave(); }
        }}
        style={{ display: 'block', flex: '1 1 0', height: '100%', minHeight: 0, overflowY: 'auto',
          color: '#ddd', background: 'transparent', border: 'none', lineHeight: 1.35, width: '100%' }} />
    </section>)}
  </div>;
}
