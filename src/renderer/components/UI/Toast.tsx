import React from 'react';
import { useUIStore } from '../../store/useUIStore';

export default function ToastContainer() {
  const { toasts, removeToast } = useUIStore();

  return (
    <div className="fixed top-16 right-4 z-[100] pointer-events-none flex flex-col gap-2 max-w-[300px]">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm transform transition-all duration-300 ease-out animate-slide-in cursor-pointer ${
            toast.type === 'success' ? 'bg-[#22c55e]/90 text-white' :
            toast.type === 'error' ? 'bg-[#ef4444]/90 text-white' :
            toast.type === 'warning' ? 'bg-[#f59e0b]/90 text-white' :
            'bg-[#3b82f6]/90 text-white'
          }`}
          onClick={() => removeToast(toast.id)}
        >
          <span className="text-sm">
            {toast.type === 'success' ? '✓' :
             toast.type === 'error' ? '✗' :
             toast.type === 'warning' ? '⚠' : 'ℹ'}
          </span>
          <span className="text-xs font-medium">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
