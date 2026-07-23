import React from 'react';
import { CircleHelp } from 'lucide-react';

interface HelpButtonProps {
  onOpenHelp: () => void;
}

export default function HelpButton({ onOpenHelp }: HelpButtonProps) {
  return (
    <button
      type="button"
      data-testid="help-button"
      aria-label="Открыть справку"
      onClick={onOpenHelp}
      className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.045] text-[#a4abb5] transition-colors hover:border-[#74c7ec]/35 hover:bg-[#74c7ec]/15 hover:text-[#74c7ec]"
      style={{ WebkitAppRegion: 'no-drag' } as any}
    >
      <CircleHelp size={16} />
    </button>
  );
}
