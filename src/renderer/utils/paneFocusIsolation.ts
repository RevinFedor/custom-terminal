const PANE_BOUNDARY_SELECTOR = '[data-terminal-pane-wrapper][data-pane-focus-isolated]';

// Sequential-focus candidates only. Walking these 40–50 nodes per History
// pane is materially cheaper than Chromium's native inert walk over every
// descendant (500–1100 nodes in the production-shaped fixture).
export const PANE_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

const FOCUSABILITY_ATTRIBUTES = [
  'tabindex',
  'href',
  'contenteditable',
  'disabled',
  'controls',
];

type BoundaryState = {
  isolated: boolean;
  originals: Map<HTMLElement, string | null>;
  observer: MutationObserver;
};

export type PaneFocusIsolationManager = {
  sync: () => void;
  dispose: () => void;
};

function isHTMLElement(value: unknown): value is HTMLElement {
  return value instanceof HTMLElement;
}

function boundaryIsIsolated(boundary: HTMLElement): boolean {
  return boundary.dataset.paneFocusIsolated === '1';
}

function tabIdOfBoundary(boundary: HTMLElement): string {
  return String(boundary.dataset.terminalPaneWrapper || 'unknown');
}

/**
 * Keyboard boundary for persistent pane surfaces.
 *
 * Hidden panes stay mounted and painted for instant workflow switching. Native
 * `inert` made Chromium revisit their complete History DOM on every switch;
 * this manager quarantines only nodes that can actually receive sequential
 * focus, restores their exact authored tabindex, and watches hidden surfaces
 * for newly mounted controls.
 */
export function createPaneFocusIsolationManager(
  root: HTMLElement,
  options: { onHiddenFocus?: (tabId: string) => void } = {},
): PaneFocusIsolationManager {
  const states = new Map<HTMLElement, BoundaryState>();
  let disposed = false;
  let redirectingFocus = false;

  const quarantineElement = (boundary: HTMLElement, state: BoundaryState, element: HTMLElement) => {
    if (element === boundary || !boundary.contains(element)) return;
    const tracked = state.originals.has(element);
    if (!tracked && !element.matches(PANE_FOCUSABLE_SELECTOR)) return;

    const current = element.getAttribute('tabindex');
    if (!tracked) {
      state.originals.set(element, current);
    } else if (current !== '-1') {
      // A hidden component intentionally changed its tabindex. Remember that
      // latest authored value before putting the element back in quarantine.
      state.originals.set(element, current);
    }
    if (current !== '-1') element.setAttribute('tabindex', '-1');
  };

  const quarantineTree = (boundary: HTMLElement, state: BoundaryState, node: Node) => {
    if (!isHTMLElement(node)) return;
    quarantineElement(boundary, state, node);
    node.querySelectorAll<HTMLElement>(PANE_FOCUSABLE_SELECTOR)
      .forEach((element) => quarantineElement(boundary, state, element));
  };

  const restoreBoundary = (boundary: HTMLElement, state: BoundaryState) => {
    state.observer.disconnect();
    for (const [element, original] of state.originals) {
      if (!boundary.contains(element)) continue;
      if (original === null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', original);
    }
    state.originals.clear();
    state.isolated = false;
  };

  const observerFor = (boundary: HTMLElement, state: BoundaryState) => new MutationObserver((records) => {
    if (disposed || !state.isolated || !boundary.isConnected) return;
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach((node) => quarantineTree(boundary, state, node));
        if (record.removedNodes.length > 0) {
          for (const element of state.originals.keys()) {
            if (!boundary.contains(element)) state.originals.delete(element);
          }
        }
        continue;
      }
      if (record.type === 'attributes' && isHTMLElement(record.target)) {
        quarantineElement(boundary, state, record.target);
      }
    }
  });

  const isolateBoundary = (boundary: HTMLElement, state: BoundaryState) => {
    if (state.isolated) return;
    state.isolated = true;
    boundary.querySelectorAll<HTMLElement>(PANE_FOCUSABLE_SELECTOR)
      .forEach((element) => quarantineElement(boundary, state, element));
    state.observer.observe(boundary, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: FOCUSABILITY_ATTRIBUTES,
    });
    const active = document.activeElement;
    if (active instanceof HTMLElement && boundary.contains(active)) {
      active.blur();
      options.onHiddenFocus?.(tabIdOfBoundary(boundary));
    }
  };

  const ensureState = (boundary: HTMLElement): BoundaryState => {
    const existing = states.get(boundary);
    if (existing) return existing;
    const state = {
      isolated: false,
      originals: new Map<HTMLElement, string | null>(),
      observer: null as unknown as MutationObserver,
    };
    state.observer = observerFor(boundary, state);
    states.set(boundary, state);
    return state;
  };

  const sync = () => {
    if (disposed) return;
    const startedAt = performance.now();
    const live = new Set(
      Array.from(root.querySelectorAll<HTMLElement>(PANE_BOUNDARY_SELECTOR)),
    );
    let isolatedCount = 0;
    let restoredCount = 0;
    for (const boundary of live) {
      const state = ensureState(boundary);
      if (boundaryIsIsolated(boundary)) {
        if (!state.isolated) isolatedCount += 1;
        isolateBoundary(boundary, state);
      } else if (state.isolated) {
        restoredCount += 1;
        restoreBoundary(boundary, state);
      }
    }
    for (const [boundary, state] of states) {
      if (live.has(boundary) && boundary.isConnected) continue;
      state.observer.disconnect();
      state.originals.clear();
      states.delete(boundary);
    }
    const elapsed = performance.now() - startedAt;
    if (elapsed >= 8) {
      console.warn('[Perf:PaneFocusIsolation] phase=sync'
        + ' isolated=' + isolatedCount
        + ' restored=' + restoredCount
        + ' boundaries=' + live.size
        + ' ms=' + elapsed.toFixed(1));
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    if (disposed || redirectingFocus || !isHTMLElement(event.target)) return;
    const boundary = event.target.closest<HTMLElement>(PANE_BOUNDARY_SELECTOR);
    if (!boundary || !root.contains(boundary) || !boundaryIsIsolated(boundary)) return;
    redirectingFocus = true;
    const tabId = tabIdOfBoundary(boundary);
    console.warn('[PaneFocusIsolation] rejected hidden focus tab=' + tabId.slice(-12));
    event.target.blur();
    options.onHiddenFocus?.(tabId);
    queueMicrotask(() => { redirectingFocus = false; });
  };
  root.addEventListener('focusin', onFocusIn, true);

  return {
    sync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('focusin', onFocusIn, true);
      for (const [boundary, state] of states) restoreBoundary(boundary, state);
      states.clear();
    },
  };
}
