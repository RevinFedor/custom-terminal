import React, { useState } from 'react';
import { 
  Database, 
  Cpu, 
  Terminal, 
  FileJson, 
  Layout, 
  Hash, 
  ExternalLink,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  Info
} from 'lucide-react';

export default function ContextSidebar() {
  const [expanded, setExpanded] = useState({ metadata: true, stats: true, health: true });

  const toggle = (key: keyof typeof expanded) => 
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="flex h-screen bg-[#0A0A0A] text-[#E0E0E0] font-mono p-4 gap-4">
      {/* Simulation of a main area */}
      <div className="flex-1 bg-[#0D0D0D] border border-[#1A1A1A] p-8 flex items-center justify-center relative overflow-hidden">
        <div className="absolute top-4 left-4 text-[10px] text-[#222222]">VIEWPORT_SIMULATION</div>
        <div className="text-[#333333] italic text-sm">Main Content Area...</div>
      </div>

      {/* The Actual Sidebar Component under test */}
      <aside className="w-80 bg-[#111111] border border-[#222222] flex flex-col shadow-2xl overflow-hidden">
        {/* Header: Session Health */}
        <div className="p-4 border-b border-[#222222] bg-[#141414]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[10px] uppercase tracking-[0.2em] text-[#666666]">System Health</h2>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className={`w-1 h-3 ${i < 5 ? 'bg-blue-500' : 'bg-blue-900/30'}`} />
              ))}
            </div>
          </div>
          
          <div className="space-y-4">
            <HealthItem label="Context Window" value="45.2%" color="bg-blue-500" />
            <HealthItem label="Token Velocity" value="1.2k/m" color="bg-amber-500" />
            <HealthItem label="Memory Load" value="892MB" color="bg-emerald-500" />
          </div>
        </div>

        {/* Scrollable Sections */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {/* Section: Metadata */}
          <Section 
            title="Session Metadata" 
            icon={<Database size={14} />} 
            isOpen={expanded.metadata} 
            onToggle={() => toggle('metadata')}
          >
            <div className="space-y-3 text-xs">
              <MetaRow label="Session ID" value="uuid-45a1-90ff" icon={<Hash size={12} />} />
              <MetaRow label="AI Model" value="sonnet-3.5" icon={<Cpu size={12} />} />
              <MetaRow label="Engine" value="node-pty" icon={<Terminal size={12} />} />
              <MetaRow label="State" value="thinking" isPulse valueColor="text-blue-400" />
            </div>
          </Section>

          {/* Section: File Flux */}
          <Section 
            title="File Flux" 
            icon={<Layout size={14} />} 
            isOpen={expanded.stats} 
            onToggle={() => toggle('stats')}
          >
            <div className="space-y-1">
              <FileRow name="database.js" type="MODIFIED" color="text-amber-500" />
              <FileRow name="main.js" type="READ" color="text-blue-500" />
              <FileRow name="package.json" type="UNTOUCHED" color="text-[#444444]" />
            </div>
          </Section>

          {/* Section: Safety Metrics */}
          <Section 
            title="Safety Protocols" 
            icon={<ShieldCheck size={14} />} 
            isOpen={expanded.health} 
            onToggle={() => toggle('health')}
          >
            <div className="p-3 bg-[#0D0D0D] border border-[#1A1A1A] rounded space-y-3">
              <div className="flex items-center gap-2 text-xs text-emerald-500">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                No injection patterns detected
              </div>
              <div className="flex items-center gap-2 text-xs text-[#666666]">
                <Info size={12} />
                Strict sandbox mode enabled
              </div>
            </div>
          </Section>
        </div>

        {/* Footer: Quick Actions */}
        <div className="p-4 border-t border-[#222222] bg-[#0D0D0D] grid grid-cols-2 gap-3">
          <ActionButton label="Export JSON" icon={<FileJson size={14} />} />
          <ActionButton label="Open Logs" icon={<ExternalLink size={14} />} />
        </div>
      </aside>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #222; }
      `}</style>
    </div>
  );
}

function HealthItem({ label, value, color }: { label: string, value: string, color: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs uppercase tracking-tight text-[#666666]">
        <span>{label}</span>
        <span className="text-[#888888]">{value}</span>
      </div>
      <div className="h-[2px] w-full bg-[#1A1A1A]">
        <div className={`h-full ${color}`} style={{ width: value }} />
      </div>
    </div>
  );
}

function Section({ title, icon, children, isOpen, onToggle }: any) {
  return (
    <div className="border-b border-[#1A1A1A]">
      <button 
        onClick={onToggle}
        className="w-full p-4 flex items-center gap-3 text-xs uppercase tracking-wider text-[#888888] hover:text-white transition-colors"
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        <span className="flex-1 text-left font-medium">{title}</span>
      </button>
      {isOpen && <div className="px-4 pb-5">{children}</div>}
    </div>
  );
}

function MetaRow({ label, value, icon, isPulse, valueColor = "text-[#E0E0E0]" }: any) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[#1A1A1A]/30 last:border-0">
      <div className="flex items-center gap-3 text-[#666666]">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`flex items-center gap-2 font-medium ${valueColor}`}>
        {isPulse && <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
        <span>{value}</span>
      </div>
    </div>
  );
}

function FileRow({ name, type, color }: any) {
  return (
    <div className="flex items-center justify-between p-2.5 hover:bg-[#1A1A1A] transition-colors group cursor-pointer rounded-sm">
      <span className="text-sm text-[#888888] group-hover:text-white transition-colors">{name}</span>
      <span className={`text-[10px] font-bold tracking-wider border border-current px-1.5 py-0.5 rounded-sm ${color} opacity-80`}>{type}</span>
    </div>
  );
}

function ActionButton({ label, icon }: any) {
  return (
    <button className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#1A1A1A] border border-[#222222] hover:border-[#444444] text-xs font-medium text-[#888888] hover:text-white transition-all rounded-sm">
      {icon}
      {label}
    </button>
  );
}
