import { useCallback, useEffect, useRef } from 'react';
import type { EditorView } from '@codemirror/view';
import { hideCommandPalette, hideContextMenu } from '@gt-editor/markdown-editor';
import { claimTaskPlanChildDismissal } from '../utils/taskPlanPopupDismissal.mjs';

/** Adopt only a menu synchronously opened by this actual editor gesture. */
export function useTaskEditorFloatingSurfaces(owner: string | undefined, onOpen: (open: boolean) => void) {
  const dispose = useRef<() => void>(() => {});
  const gesture = useRef<(event: Event) => void>(() => {});
  const latest = useRef(onOpen); latest.current = onOpen;
  useEffect(() => () => dispose.current(), []);
  const onEditorView = useCallback((view: EditorView | null) => {
    dispose.current(); dispose.current = () => {};
    if (!view || !owner) return;
    view.dom.dataset.taskPlanEditorViewOwner = owner;
    const selector = '[data-command-palette],[data-context-menu]';
    const menus = new Set<HTMLElement>();
    let before: Set<Element> | null = null;
    const stop = (event: Event) => event.stopPropagation();
    const close = () => {
      // The package has one active palette/menu. Never close another editor's
      // replacement merely because this instance once owned an earlier one.
      for (const menu of menus) if (menu.isConnected) {
        if (menu.hasAttribute('data-command-palette')) hideCommandPalette();
        else hideContextMenu();
      }
    };
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && [...menus].some(menu => menu.contains(event.target as Node))) return;
      if ([...menus].some(menu => menu.isConnected)) claimTaskPlanChildDismissal(event, owner);
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || ![...menus].some(menu => menu.isConnected)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      close();
    };
    const update = () => {
      for (const menu of menus) if (!menu.isConnected) menus.delete(menu);
      latest.current(menus.size > 0);
      if (!menus.size) {
        observer.disconnect(); document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', escape, true);
      }
    };
    const observer = new MutationObserver(update);
    const track = (event: Event) => {
      if (!(event.target instanceof Node) || !view.dom.contains(event.target)) return;
      if (event instanceof KeyboardEvent && !((event.metaKey || event.ctrlKey) && event.code === 'Slash')) return;
      before = new Set(document.querySelectorAll(selector));
    };
    const adopt = () => {
        const previous = before; before = null;
        if (!previous || !view.dom.isConnected) return;
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (previous.has(element)) continue;
          element.dataset.taskPlanPopupOwner = owner;
          element.dataset.taskPlanEditorMenu = 'true';
          element.style.zIndex = '2147482402';
          element.addEventListener('mousedown', stop); element.addEventListener('click', stop);
          menus.add(element);
        }
        if (menus.size) {
          latest.current(true); observer.observe(document.body, { childList: true });
          document.addEventListener('mousedown', outside, true);
          document.addEventListener('keydown', escape, true);
        }
    };
    gesture.current = track;
    // CodeMirror opens the menu in its native contentDOM handler. This listener
    // runs after it on the same node, even when it stops bubbling. A microtask
    // from React capture can run BEFORE that handler and is not a post-event proof.
    view.contentDOM.addEventListener('keydown', adopt); view.contentDOM.addEventListener('contextmenu', adopt);
    dispose.current = () => {
      close(); observer.disconnect();
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', escape, true);
      if (gesture.current === track) gesture.current = () => {};
      view.contentDOM.removeEventListener('keydown', adopt); view.contentDOM.removeEventListener('contextmenu', adopt);
      latest.current(false);
    };
  }, [owner]);
  // Capture at the host ancestor before CodeMirror handles this gesture.
  const trackGesture = useCallback((event: Event) => gesture.current(event), []);
  return { onEditorView, trackGesture };
}
