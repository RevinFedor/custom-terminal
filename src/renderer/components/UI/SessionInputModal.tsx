import React, { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';

export default function SessionInputModal() {
  const { sessionModal, closeSessionModal } = useUIStore();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sessionModal.open) {
      setValue(sessionModal.placeholder);
      setTimeout(() => inputRef.current?.select(), 100);
    }
  }, [sessionModal.open, sessionModal.placeholder]);

  const handleConfirm = () => {
    closeSessionModal(value.trim() || null);
  };

  const handleCancel = () => {
    closeSessionModal(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (!sessionModal.open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]"
      onClick={handleCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-panel border border-border-main rounded-xl p-6 w-[400px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">{sessionModal.title}</h2>
          <button
            className="text-[#888] hover:text-white text-2xl leading-none"
            onClick={handleCancel}
          >
            ×
          </button>
        </div>

        {/* Form */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-[#888] uppercase mb-1">
              {sessionModal.label}
            </label>
            <input
              ref={inputRef}
              type="text"
              className="w-full bg-[#2d2d2d] border border-[#444] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-accent"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </div>

          {sessionModal.hint && (
            <p className="text-[10px] text-[#666] italic">{sessionModal.hint}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 mt-6">
          <button
            className="px-4 py-2 text-sm text-[#ccc] hover:text-white transition-colors"
            onClick={handleCancel}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/80 transition-colors"
            onClick={handleConfirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
