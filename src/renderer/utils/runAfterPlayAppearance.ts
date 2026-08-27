export type RunAfterPlayAppearance = {
  background: string;
  borderColor: string;
  color: string;
  opacity: number;
};

type RunAfterPlayAppearanceInput = {
  autoRun: boolean;
  activeItemCount: number;
  firstChipArmedHint: boolean;
  hovered: boolean;
};

// One visual contract for every Run After Play/Pause entrance. The rail owns
// the product states; secondary entrances may change the glyph (filled vs
// outline), but must not invent a second colour language.
export function resolveRunAfterPlayAppearance({
  autoRun,
  activeItemCount,
  firstChipArmedHint,
  hovered,
}: RunAfterPlayAppearanceInput): RunAfterPlayAppearance {
  if (autoRun) {
    return {
      background: hovered ? '#342a52' : '#2b2340',
      borderColor: hovered ? '#a78bfa' : '#8b75d9',
      color: '#a78bfa',
      opacity: 1,
    };
  }
  if (firstChipArmedHint) {
    return {
      background: hovered ? 'rgba(127, 29, 29, 0.22)' : 'rgba(127, 29, 29, 0.14)',
      borderColor: hovered ? 'rgba(239, 68, 68, 0.48)' : 'rgba(239, 68, 68, 0.32)',
      color: '#b96b6b',
      opacity: 1,
    };
  }
  if (activeItemCount > 0) {
    return {
      background: hovered ? '#303030' : '#242424',
      borderColor: hovered ? '#666' : '#4a4a4a',
      color: '#d6d6d6',
      opacity: 1,
    };
  }
  return {
    background: '#1d1d1d',
    borderColor: '#343434',
    color: '#555',
    opacity: 0.58,
  };
}
