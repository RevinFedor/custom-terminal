const MENU='[data-tab-context-menu],[data-tab-status-marker-menu],[data-tab-linked-files-popup]';

/** DOM ownership labels only. A menu about another tab cannot keep this group's
 * hover alive. This is presentation, not an execution/membership proof. */
export function paneStripHoverMenu(target,memberIds) {
  const node=target?.closest?.(MENU);if(!node)return {menu:false,owned:false};
  const label=node.closest?.('[data-tab-menu-owner-id]');
  const owner=node.dataset?.tabLinkedFilesPopup||label?.dataset?.tabMenuOwnerId;
  return {menu:true,owned:typeof owner==='string'&&memberIds.includes(owner)};
}
export function paneStripHoverInside({root,target,memberIds,boxes=[],open=false,x,y}) {
  const menu=paneStripHoverMenu(target,memberIds);if(menu.menu)return menu.owned;
  // Synthetic window-level mouse events have an EventTarget that is not a DOM
  // Node. They may use the captured row bounds, but cannot throw in a handler.
  try{if(root?.contains(target))return true;}catch{}
  // The same-row gaps belong to the exposed group. No live rectangle read.
  if(!open||!boxes.length||!Number.isFinite(x)||!Number.isFinite(y))return false;
  return x>=Math.min(...boxes.map(box=>box.left))-2&&x<=Math.max(...boxes.map(box=>box.right))+2
    &&y>=Math.min(...boxes.map(box=>box.top))-2&&y<=Math.max(...boxes.map(box=>box.bottom))+2;
}
