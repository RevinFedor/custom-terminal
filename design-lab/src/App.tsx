import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X, Box, FileCode, Search, RefreshCw, Layers } from 'lucide-react';

// Vite magic: auto-import all .tsx files from designs/ folder
const designModules = import.meta.glob('./designs/**/*.tsx', { eager: true });

export default function App() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedDesign, setSelectedDesign] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Extract keys and components
  const designs = useMemo(() => {
    return Object.entries(designModules).map(([path, module]: [string, any]) => {
      // Convert "./designs/TimelineDAG.tsx" to "TimelineDAG"
      const name = path.split('/').pop()?.replace('.tsx', '') || path;
      return {
        id: path,
        name,
        Component: module.default,
      };
    });
  }, []);

  // Set default design if not set
  useEffect(() => {
    if (!selectedDesign && designs.length > 0) {
      setSelectedDesign(designs[0].id);
    }
  }, [designs, selectedDesign]);

  const CurrentComponent = useMemo(() => {
    const found = designs.find((d) => d.id === selectedDesign);
    return found ? found.Component : null;
  }, [selectedDesign, designs]);

  const filteredDesigns = designs.filter((d) =>
    d.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen w-full bg-[#0A0A0A] text-[#E0E0E0] font-sans selection:bg-blue-500/30 overflow-hidden relative">
      
      {/* 1. Floating Toggle Button (Meta-level, Ultra-fast) */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            onClick={() => setIsOpen(true)}
            className="absolute top-6 left-6 z-[9999] p-3 bg-[#111111] border border-[#333333] hover:border-[#666666] text-[#888888] hover:text-white transition-all shadow-2xl cursor-pointer rounded-sm flex items-center justify-center group"
          >
            <Menu size={20} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* 2. Meta-level Sidebar (No backdrop, high-speed transition) */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'tween', duration: 0.15, ease: 'easeOut' }}
            className="absolute top-0 left-0 bottom-0 w-[360px] bg-[#111111] border-r border-[#222222] z-[10000] shadow-[20px_0_50px_rgba(0,0,0,0.5)] flex flex-col font-mono"
          >
            {/* Header */}
            <div className="p-8 border-b border-[#222222] flex items-center justify-between">
              <div className="flex items-center gap-3 text-white font-bold tracking-tight">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-sm">DESIGN LAB</span>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 hover:bg-[#1A1A1A] text-[#666666] hover:text-white transition-colors cursor-pointer rounded-sm"
              >
                <X size={20} />
              </button>
            </div>

            {/* Search - BULLETPROOF FLEXBOX */}
            <div className="px-8 py-6 border-b border-[#1A1A1A]">
              {/* The outer div acts as the input visual boundary */}
              <div className="flex items-center gap-3 w-full bg-[#0A0A0A] border border-[#222222] focus-within:border-blue-500/50 px-4 py-3.5 rounded-sm transition-all group shadow-inner">
                {/* Icon is a flex sibling, impossible to overlap */}
                <Search size={18} className="text-[#555555] group-focus-within:text-blue-500 transition-colors flex-shrink-0" />
                
                {/* Transparent input takes remaining space */}
                <input
                  type="text"
                  placeholder="Filter designs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-transparent outline-none text-sm text-[#E0E0E0] placeholder-[#555555] cursor-text"
                />
              </div>
            </div>

            {/* List - Increased padding */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-2 custom-scrollbar">
              {filteredDesigns.map((design) => (
                <button
                  key={design.id}
                  onClick={() => {
                    setSelectedDesign(design.id);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-5 py-4 flex items-center gap-4 text-sm transition-all relative overflow-hidden group cursor-pointer rounded-sm ${
                    selectedDesign === design.id
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-900/30'
                      : 'text-[#888888] hover:bg-[#1A1A1A] hover:text-[#E0E0E0] border border-transparent'
                  }`}
                >
                  {selectedDesign === design.id && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500" />
                  )}
                  <FileCode size={18} className={selectedDesign === design.id ? 'text-blue-500' : 'text-[#444444]'} />
                  <span className="truncate flex-1 font-medium">{design.name}</span>
                </button>
              ))}
            </div>

            {/* Footer */}
            <div className="p-8 bg-[#0D0D0D] border-t border-[#1A1A1A]">
              <div className="flex items-center gap-3 text-xs text-[#555555] mb-3 uppercase tracking-wider font-bold">
                <RefreshCw size={14} /> AUTO-SCANNING
              </div>
              <p className="text-xs text-[#444444] leading-relaxed">
                Source: <span className="text-[#666666]">src/designs/*.tsx</span>
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3. Main Viewport (Isolated Canvas) */}
      <main className="flex-1 h-full w-full relative bg-[#0A0A0A] overflow-auto flex flex-col">
        {CurrentComponent ? (
          <div className="w-full h-full">
            <CurrentComponent />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full flex-col gap-4">
            <Box size={48} className="text-[#1A1A1A]" strokeWidth={1} />
            <div className="text-[#333333] text-[10px] uppercase tracking-[0.5em]">No design selected</div>
          </div>
        )}

        {/* Floating Debug Marker (Bottom Right) */}
        <div className="fixed bottom-4 right-4 text-[9px] text-[#222222] font-mono pointer-events-none">
          {selectedDesign?.split('/').pop()} | LAB_RUNNING
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #0A0A0A;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1A1A1A;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #222222;
        }
      `}</style>
    </div>
  );
}
