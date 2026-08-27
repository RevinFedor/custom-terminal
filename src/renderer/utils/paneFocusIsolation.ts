const PANE_BOUNDARY_SELECTOR = [
  '[data-terminal-pane-wrapper][data-pane-focus-isolated]',
  '[data-terminal-pane-chrome-host][data-pane-focus-isolated]',
].join(',');

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
  return String(
    boundary.dataset.terminalPaneWrapper
    || boundary.dataset.terminalPaneChromeHost
    || 'unknown',
  );
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
  options: {
    onHiddenFocus?: (tabId: string) => void;
    boundarySelector?: string;
  } = {},
): PaneFocusIsolationManager {
  const states = new Map<HTMLElement, BoundaryState>();
  let disposed = false;
  let redirectingFocus = false;
  let boundarySequence = 0;
  const boundaryIds = new WeakMap<HTMLElement, number>();
  let lastDesiredSignature = '';
  let presentationVersion = 0;
  let deferredFrame = 0;
  let deferredTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingHiddenFocusBoundary: HTMLElement | null = null;

  const boundaryId = (boundary: HTMLElement): number => {
    const existing = boundaryIds.get(boundary);
    if (existing) return existing;
    const next = ++boundarySequence;
    boundaryIds.set(boundary, next);
    return next;
  };

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

  const cancelDeferred = () => {
    if (deferredFrame) cancelAnimationFrame(deferredFrame);
    if (deferredTimer !== null) clearTimeout(deferredTimer);
    deferredFrame = 0;
    deferredTimer = null;
  };

  const boundarySelector = options.boundarySelector || PANE_BOUNDARY_SELECTOR;
  const liveBoundaries = () => Array.from(
    root.querySelectorAll<HTMLElement>(boundarySelector),
  );

  const cleanupDetachedStates = (live: Set<HTMLElement>) => {
    for (const [boundary, state] of states) {
      if (live.has(boundary) && boundary.isConnected) continue;
      state.observer.disconnect();
      state.originals.clear();
      states.delete(boundary);
    }
  };

  // `tabindex` is an accessibility property, but changing it on CodeMirror's
  // control root invalidates :focus/:focus-within styles for its complete
  // transcript subtree. Six synchronous changes cost 57–100 ms before the
  // first workflow frame in the production-shaped trace. The focusin guard
  // below remains synchronous; authored tabindex restoration/quarantine is
  // applied one boundary per rendered frame after the visual handoff.
  const flushOneBoundary = (version: number) => {
    if (disposed || version !== presentationVersion) return;
    deferredFrame = 0;
    deferredTimer = null;
    const liveList = liveBoundaries();
    const live = new Set(liveList);
    cleanupDetachedStates(live);
    const entries = liveList.map((boundary) => ({
      boundary,
      state: ensureState(boundary),
      desiredIsolated: boundaryIsIsolated(boundary),
    }));
    // Restore the newly visible pane first so keyboard navigation becomes
    // complete immediately after the first visual frame. Outgoing panes are
    // still protected during the short queue by the capture focusin guard.
    const operation = entries.find(({ state, desiredIsolated }) => (
      !desiredIsolated && state.isolated
    )) || entries.find(({ state, desiredIsolated }) => (
      desiredIsolated && !state.isolated
    ));
    if (!operation) return;
    const pendingCount = entries.filter(({ state, desiredIsolated }) => (
      desiredIsolated !== state.isolated
    )).length;

    const startedAt = performance.now();
    if (operation.desiredIsolated) {
      isolateBoundary(operation.boundary, operation.state);
    } else {
      restoreBoundary(operation.boundary, operation.state);
    }
    const elapsed = performance.now() - startedAt;
    console.warn('[Perf:PaneFocusIsolation] phase=deferred'
      + ' action=' + (operation.desiredIsolated ? 'isolate' : 'restore')
      + ' tab=' + tabIdOfBoundary(operation.boundary).slice(-12)
      + ' remaining=' + Math.max(0, pendingCount - 1)
      + ' ms=' + elapsed.toFixed(1));

    deferredFrame = requestAnimationFrame(() => {
      deferredFrame = 0;
      deferredTimer = setTimeout(() => flushOneBoundary(version), 0);
    });
  };

  const sync = () => {
    if (disposed) return;
    const liveList = liveBoundaries();
    const live = new Set(liveList);
    cleanupDetachedStates(live);

    // A pane can become hidden while its composer owns focus. Do NOT blur it in
    // this layout effect: losing CodeMirror focus invalidates its focus subtree
    // and used to add 117–133 ms before the new workflow could paint. The
    // common focus resolver transfers ownership from the exact presented-wrapper
    // mutation, without a timer. Until that commit the key/beforeinput capture
    // guards below reject input aimed at the newly hidden boundary.
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const hiddenOwner = liveList.find((boundary) => (
        boundaryIsIsolated(boundary) && boundary.contains(active)
      ));
      if (hiddenOwner) {
        if (pendingHiddenFocusBoundary !== hiddenOwner) {
          pendingHiddenFocusBoundary = hiddenOwner;
          options.onHiddenFocus?.(tabIdOfBoundary(hiddenOwner));
        }
      } else {
        pendingHiddenFocusBoundary = null;
      }
    }

    const signature = liveList
      .map((boundary) => `${boundaryId(boundary)}:${boundaryIsIsolated(boundary) ? 1 : 0}`)
      .join('|');
    if (signature === lastDesiredSignature) return;
    lastDesiredSignature = signature;
    presentationVersion += 1;
    const version = presentationVersion;
    cancelDeferred();
    // rAF callback runs before paint; the zero-delay task runs after that paint.
    // Thus the workflow acknowledgement is visible before any tabindex work.
    deferredFrame = requestAnimationFrame(() => {
      deferredFrame = 0;
      deferredTimer = setTimeout(() => flushOneBoundary(version), 0);
    });
  };

  const onFocusIn = (event: FocusEvent) => {
    if (disposed || redirectingFocus || !isHTMLElement(event.target)) return;
    const boundary = event.target.closest<HTMLElement>(boundarySelector);
    if (!boundary || !root.contains(boundary) || !boundaryIsIsolated(boundary)) return;
    redirectingFocus = true;
    const tabId = tabIdOfBoundary(boundary);
    console.warn('[PaneFocusIsolation] rejected hidden focus tab=' + tabId.slice(-12));
    event.target.blur();
    options.onHiddenFocus?.(tabId);
    queueMicrotask(() => { redirectingFocus = false; });
  };
  const onHiddenInput = (event: Event) => {
    if (disposed || !isHTMLElement(event.target)) return;
    const boundary = event.target.closest<HTMLElement>(boundarySelector);
    if (!boundary || !root.contains(boundary) || !boundaryIsIsolated(boundary)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const tabId = tabIdOfBoundary(boundary);
    console.warn('[PaneFocusIsolation] rejected hidden input tab=' + tabId.slice(-12)
      + ' type=' + event.type);
    options.onHiddenFocus?.(tabId);
  };
  root.addEventListener('focusin', onFocusIn, true);
  root.addEventListener('keydown', onHiddenInput, true);
  root.addEventListener('beforeinput', onHiddenInput, true);

  return {
    sync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      presentationVersion += 1;
      cancelDeferred();
      root.removeEventListener('focusin', onFocusIn, true);
      root.removeEventListener('keydown', onHiddenInput, true);
      root.removeEventListener('beforeinput', onHiddenInput, true);
      for (const [boundary, state] of states) restoreBoundary(boundary, state);
      states.clear();
    },
  };
}
