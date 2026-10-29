import React, { useId } from 'react';
import scDesktopIcon from '../../assets/sc-desktop.png';

/** Keep the existing SC artwork and exact marker bounds. Only a terminal error
 * receives a theme-colored SVG tint; normal states keep their original image. */
export function ResearchTimelineIcon({ failed, title, style }: {
  failed: boolean; title: string; style: React.CSSProperties;
}) {
  const tintId = 'research-error-' + useId().replace(/:/g, '');
  if (!failed) return <img src={scDesktopIcon} alt="" data-timeline-sc-desktop title={title} style={style} />;
  return <svg viewBox="0 0 32 32" aria-hidden="true" data-timeline-sc-desktop data-research-failed="true"
    fill="currentColor" stroke="none" style={{ ...style, color: 'var(--cb-error-text, #f38ba8)' }}>
    <title>{title}</title>
    <defs>
      <filter id={tintId} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feFlood floodColor="currentColor" result="tint" />
        <feComposite in="tint" in2="SourceGraphic" operator="in" result="colored" />
        <feBlend in="colored" in2="SourceGraphic" mode="color" />
      </filter>
    </defs>
    <image href={scDesktopIcon} width="32" height="32" filter={`url(#${tintId})`} />
  </svg>;
}
