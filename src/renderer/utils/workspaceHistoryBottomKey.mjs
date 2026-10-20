import {resolveFocusedTerminalSelection} from './focusedTerminalContext.mjs';
import {resolvePtyAgentOwner} from './ptyAgentOwner.mjs';

// One native event can visit the composer's pre-keymap handler and then the
// workspace's existing global handler. This weak marker is not another input
// owner and never stores drafts, focus or tab state.
const requested=new WeakSet();
export function requestFocusedHistoryBottomKey(event,{workspace,ui,composerTabId=null,
  terminalPrimary=()=>false,dispatchHistory}) {
  if(event?.key!=='ArrowDown'||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey
    ||event.repeat||event.isComposing||event.defaultPrevented)return false;
  if(requested.has(event))return true;
  if(ui.activeArea!=='workspace'||ui.workflowSettingsId||ui.promptPickerOpen||ui.filePreview)return false;
  const focused=resolveFocusedTerminalSelection(workspace).selection;
  if(!focused||composerTabId&&composerTabId!==focused.tabId)return false;
  const tab=workspace.openProjects.get(focused.projectId)?.tabs.get(focused.tabId);
  const owner=resolvePtyAgentOwner(tab||{});
  if(owner!=='claude'&&owner!=='codex')return false;
  const target=event.target;
  if(target?.closest?.('.xterm, [role="dialog"], [aria-modal="true"], [role="listbox"], [role="combobox"], [role="menu"], [data-tab-context-menu], [data-run-after-picker-menu], [data-history-search-panel]'))return false;
  const editor=target?.closest?.('[data-history-composer-tab-id]');
  if(composerTabId) {
    if(editor?.getAttribute('data-history-composer-tab-id')!==focused.tabId
      ||target?.closest?.('input, select')||target?.closest?.('.cm-editor')?.querySelector('.cm-tooltip-autocomplete'))return false;
  } else if(target?.closest?.('input, textarea, select, [contenteditable="true"]'))return false;
  const history=target?.closest?.('[data-history-tab-id]');
  const readingHistory=history?.getAttribute('data-history-tab-id')===focused.tabId&&history?.getAttribute('data-history-presented')==='1';
  if(!composerTabId&&terminalPrimary(focused.tabId)&&!readingHistory)return false;
  requested.add(event);
  // Composer caret/Undo/input remain with CodeMirror. The command observes
  // that same key before its native navigation, without preventing the edit.
  if(!composerTabId)event.preventDefault();
  dispatchHistory(focused.tabId);return true;
}
