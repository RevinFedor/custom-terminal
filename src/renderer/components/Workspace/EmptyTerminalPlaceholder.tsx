import React from 'react';

interface EmptyTerminalPlaceholderProps {
  projectName: string;
  onCreateTab: () => void;
}

export default function EmptyTerminalPlaceholder({ projectName, onCreateTab }: EmptyTerminalPlaceholderProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-bg-main">
      <div className="text-center max-w-md px-8">
        <div className="text-6xl mb-6 opacity-20">
          &gt;_
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">
          {projectName}
        </h2>
        <p className="text-[#888] text-sm mb-6">
          No terminals open. Create a new terminal to start working with this project.
        </p>
        <button
          onClick={onCreateTab}
          className="px-6 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors cursor-pointer"
        >
          New Terminal
        </button>
        <div className="mt-6 text-[#555] text-xs">
          or press <kbd className="px-1.5 py-0.5 bg-[#333] rounded">Cmd+T</kbd>
        </div>
      </div>
    </div>
  );
}
