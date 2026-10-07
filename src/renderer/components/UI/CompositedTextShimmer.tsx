import React, { useId, useLayoutEffect, useRef } from 'react';
import './compositedTextShimmer.css';

type CompositedTextShimmerProps = {
  children: string;
  className?: string;
  variant: 'working' | 'naming';
};

type MaskPlan = {
  prepareGlyph?: () => void;
  glyphFits?: () => boolean;
  shortenGlyph?: () => void;
  commit: () => void;
};
type MaskMeasurement = {
  read: () => MaskPlan | null;
};

// Resize/font changes can affect many retained labels in one frame. Read all
// their boxes before any SVG write; alternating the two forces global layout
// once per label. This queue runs only after a real change, never per animation
// frame. Ordinary same-width timer text is already updated by React and does
// not enqueue geometry work at all.
const dirtyMasks = new Set<MaskMeasurement>();
let measurementFrame: number | null = null;
const resizeOwners = new Map<Element, MaskMeasurement>();
let maskResizeObserver: ResizeObserver | null = null;
function measureMasks(tasks: MaskMeasurement[]) {
  const plans = tasks.map(task => task.read()).filter((plan): plan is MaskPlan => plan !== null);
  // Ellipsized naming text needs native shaping. Normalize all dirty names
  // before any length read, then fit them in shared rounds: never alternate
  // one owner's SVG writes with the next owner's geometry reads.
  for (const plan of plans) plan.prepareGlyph?.();
  let oversized = plans.filter(plan => plan.glyphFits && !plan.glyphFits());
  while (oversized.length > 0) {
    for (const plan of oversized) plan.shortenGlyph?.();
    oversized = oversized.filter(plan => !plan.glyphFits?.());
  }
  for (const plan of plans) plan.commit();
}
function enqueueMaskMeasurement(task: MaskMeasurement) {
  dirtyMasks.add(task);
  if (measurementFrame !== null) return;
  measurementFrame = requestAnimationFrame(() => {
    measurementFrame = null;
    const tasks = Array.from(dirtyMasks);
    dirtyMasks.clear();
    measureMasks(tasks);
  });
}
function forgetMaskMeasurement(task: MaskMeasurement) {
  dirtyMasks.delete(task);
  if (dirtyMasks.size === 0 && measurementFrame !== null) {
    cancelAnimationFrame(measurementFrame);
    measurementFrame = null;
  }
}
function observeMaskGeometry(elements: Element[], task: MaskMeasurement) {
  if (!maskResizeObserver) {
    maskResizeObserver = new ResizeObserver(entries => {
      const tasks = new Set<MaskMeasurement>();
      for (const entry of entries) {
        const owner = resizeOwners.get(entry.target);
        if (owner) tasks.add(owner);
      }
      for (const owner of tasks) forgetMaskMeasurement(owner);
      // RO delivery is already before paint. One observer reads every changed
      // label before writing any mask, including first show and width growth.
      // Do not postpone that valid geometry to the following frame.
      measureMasks(Array.from(tasks));
    });
  }
  for (const element of elements) {
    resizeOwners.set(element, task);
    maskResizeObserver.observe(element);
  }
  return () => {
    for (const element of elements) {
      resizeOwners.delete(element);
      maskResizeObserver?.unobserve(element);
    }
    if (resizeOwners.size === 0) {
      maskResizeObserver?.disconnect();
      maskResizeObserver = null;
    }
  };
}
function setMaskAttribute(element: Element, name: string, value: number) {
  const next = String(value);
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

/** The native text still owns layout, selection and accessibility. A static
 * SVG glyph mask uses the same inherited font (including loaded web fonts and
 * tabular figures); only the oversized HTML gradient moves in the compositor.
 * No canvas/font approximation, animation timer or document observer. */
export function CompositedTextShimmer({ children, className = '', variant }: CompositedTextShimmerProps) {
  const id = `text-shimmer-${useId().replace(/:/g, '')}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const sourceRef = useRef<HTMLSpanElement>(null);
  const baselineRef = useRef<HTMLSpanElement>(null);
  const maskRef = useRef<SVGMaskElement>(null);
  const glyphRef = useRef<SVGTextElement>(null);
  const measureRef = useRef<MaskMeasurement | null>(null);
  const previousRef = useRef<{ children: string; variant: string; className: string } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const baseline = baselineRef.current;
    const mask = maskRef.current;
    const glyph = glyphRef.current;
    if (!root || !baseline || !mask || !glyph) return;
    const task: MaskMeasurement = measureRef.current ?? { read: () => null };
    measureRef.current = task;
    task.read = () => {
      if (!root.isConnected) return null;
      // A display:none arm has no valid geometry. Keep the last mask rather
      // than writing zero dimensions or reading an inactive SVG text layout.
      const box = root.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return null;
      const baselineY = baseline.getBoundingClientRect().top - box.top;
      let end = children.length;
      return {
        // React already writes Working text. Restore only a shortened naming
        // label before a real resize/font change recomputes its native fit.
        prepareGlyph: variant === 'naming' ? () => {
          if (glyph.textContent !== children) glyph.textContent = children;
        } : undefined,
        glyphFits: variant === 'naming' ? () => end === 0 || glyph.getComputedTextLength() <= box.width : undefined,
        shortenGlyph: variant === 'naming' ? () => {
          const next = children.slice(0, --end) + '…';
          if (glyph.textContent !== next) glyph.textContent = next;
        } : undefined,
        commit: () => {
          setMaskAttribute(mask, 'width', box.width);
          setMaskAttribute(mask, 'height', box.height);
          setMaskAttribute(glyph, 'y', baselineY);
        },
      };
    };
    const previous = previousRef.current;
    previousRef.current = { children, variant, className };
    if (!previous) {
      // First mount must have its real mask before the first visible paint.
      measureMasks([task]);
    } else if (previous.variant !== variant || previous.className !== className
      || variant === 'naming' && previous.children !== children) {
      enqueueMaskMeasurement(task);
    }
    // Working width/height changes (including hour rollover) arrive through
    // ResizeObserver. A same-width second needs no box read or SVG rewrite.
  }, [children, variant, className]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const source = sourceRef.current;
    if (!root || !source) return;
    const task = measureRef.current;
    if (!task) return;
    const measure = () => enqueueMaskMeasurement(task);
    const stopObserving = observeMaskGeometry([root, source], task);
    // A freshly loaded face can change its baseline without changing an
    // explicitly sized naming box. The observer is retained across 1Hz ticks.
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      stopObserving();
      document.fonts.removeEventListener('loadingdone', measure);
      forgetMaskMeasurement(task);
    };
  }, []);

  return (
    <span ref={rootRef} className={`${className} noted-text-shimmer noted-text-shimmer--${variant}`}>
      <span ref={sourceRef} className="noted-text-shimmer__source">
        {children}<span ref={baselineRef} className="noted-text-shimmer__baseline" />
      </span>
      <span aria-hidden="true" className="noted-text-shimmer__mask" style={{ WebkitMaskImage: `url("#${id}")`, maskImage: `url("#${id}")` }}>
        <span className="noted-text-shimmer__raster noted-infinite-animation" />
      </span>
      <svg aria-hidden="true" className="noted-text-shimmer__definitions">
        <defs>
          <mask ref={maskRef} id={id} x="0" y="0" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
            <text ref={glyphRef} x="0" fill="white">{children}</text>
          </mask>
        </defs>
      </svg>
    </span>
  );
}
