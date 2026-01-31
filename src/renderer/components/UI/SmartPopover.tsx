import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SmartPopoverProps {
  children: React.ReactNode;
  content: string;
  isOpen: boolean;
}

export default function SmartPopover({ children, content, isOpen }: SmartPopoverProps) {
  const [side, setSide] = useState<'left' | 'right'>('right');
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const popoverWidth = 220; // Reduced width (approx 1.5x smaller than usual 350px)
      const spaceOnRight = window.innerWidth - rect.right;
      
      if (spaceOnRight < popoverWidth + 20) {
        setSide('left');
      } else {
        setSide('right');
      }
    }
  }, [isOpen]);

  return (
    <div className="relative inline-block" ref={triggerRef}>
      {children}
      
      <AnimatePresence>
        {isOpen && content && (
          <motion.div
            ref={popoverRef}
            initial={{ 
              opacity: 0, 
              x: side === 'right' ? -10 : 10,
              scale: 0.95 
            }}
            animate={{ 
              opacity: 1, 
              x: side === 'right' ? 5 : -5, 
              scale: 1 
            }}
            exit={{ 
              opacity: 0, 
              x: side === 'right' ? -10 : 10,
              scale: 0.95 
            }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            className={`absolute top-0 z-[110] w-[220px] p-3 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl pointer-events-none`}
            style={{
              [side === 'right' ? 'left' : 'right']: '100%',
            }}
          >
            <div className="text-xs text-gray-400 leading-relaxed italic">
              {content}
            </div>
            {/* Small arrow indicator */}
            <div 
              className={`absolute top-3 w-2 h-2 bg-[#1e1e1e] border-t border-l border-white/10 rotate-45 ${
                side === 'right' ? '-left-1' : '-right-1 rotate-[225deg]'
              }`} 
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
