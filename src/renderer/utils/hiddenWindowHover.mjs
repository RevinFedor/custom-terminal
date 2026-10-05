import { pointInHoverCluster } from './hoverBridge.mjs';

/** Keep-open corridor only; it neither opens the popup nor intercepts input. */
export function hiddenWindowHoverContains({ popup, button, header, x, y, pad = 6 }) {
  const corridor = button && header ? {
    left: Math.min(button.left, header.left), right: button.right,
    top: button.top, bottom: button.bottom,
  } : button;
  return pointInHoverCluster({ hub: popup, satellites: [corridor], x, y, pad });
}
