import React from 'react';
import { GitFork, History, Zap, Activity } from 'lucide-react';

export default function TimelineDAG() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#E0E0E0] p-8 font-mono">
      <div className="max-w-4xl mx-auto space-y-12 relative">
        {/* Timeline Line (Center) */}
        <div className="absolute left-[50%] top-0 bottom-0 w-[1px] bg-[#1A1A1A] -translate-x-1/2" />

        <header className="text-center relative z-10">
          <h2 className="text-sm uppercase tracking-[0.2em] text-[#666666] mb-2">Experimental UI</h2>
          <h1 className="text-2xl font-bold tracking-tight">DAG Timeline Concept</h1>
        </header>

        {/* Node: Root */}
        <div className="flex justify-center relative">
          <div className="bg-[#111111] border border-[#222222] p-5 w-80 hover:border-[#444444] transition-all relative z-10 group rounded-sm shadow-md">
            <div className="flex items-center gap-2 mb-3 text-[#888888] text-xs font-medium uppercase tracking-wider">
              <History size={14} />
              <span>ROOT SESSION</span>
              <span className="ml-auto">12:45:01</span>
            </div>
            <p className="text-base leading-relaxed mb-5 text-[#E0E0E0]">Initial prompt: Analyze the current project architecture.</p>
            <div className="flex gap-2">
              <span className="bg-[#1A1A1A] px-2.5 py-1 text-xs border border-[#333333] rounded-sm text-[#AAAAAA]">#node-pty</span>
              <span className="bg-[#1A1A1A] px-2.5 py-1 text-xs border border-[#333333] rounded-sm text-[#AAAAAA]">#sqlite</span>
            </div>
          </div>
        </div>

        {/* Node Split (Fork) */}
        <div className="grid grid-cols-2 gap-32 relative pt-8">
          {/* Connector: Left Fork */}
          <div className="absolute top-0 left-[50%] w-[50%] h-[80px] border-l border-t border-[#333333] -translate-x-full rounded-tl-2xl" />
          {/* Connector: Right Fork */}
          <div className="absolute top-0 right-[50%] w-[50%] h-[80px] border-r border-t border-[#333333] translate-x-full rounded-tr-2xl" />

          {/* Left Fork */}
          <div className="space-y-8">
            <div className="bg-[#111111] border border-[#222222] p-5 hover:border-blue-900/50 transition-all relative z-10 rounded-sm shadow-md">
              <div className="flex items-center gap-2 mb-3 text-blue-500 text-xs font-medium uppercase tracking-wider">
                <GitFork size={14} />
                <span>FORK: OPTIMIZATION</span>
                <span className="ml-auto">12:48:22</span>
              </div>
              <p className="text-base leading-relaxed text-[#E0E0E0]">Let's try to optimize IPC calls using batching.</p>
            </div>
          </div>

          {/* Right Fork */}
          <div className="space-y-8">
            <div className="bg-[#111111] border border-[#222222] p-5 hover:border-amber-900/50 transition-all relative z-10 rounded-sm shadow-md">
              <div className="flex items-center gap-2 mb-3 text-amber-500 text-xs font-medium uppercase tracking-wider">
                <GitFork size={14} />
                <span>FORK: DEBUG LOGS</span>
                <span className="ml-auto">12:49:10</span>
              </div>
              <p className="text-base leading-relaxed text-[#E0E0E0]">Add centralized logging for all subprocesses.</p>
            </div>
          </div>
        </div>

        {/* Compaction Marker */}
        <div className="flex justify-center py-6">
          <div className="flex items-center gap-4 text-[#666666] text-xs font-medium uppercase tracking-widest bg-[#0D0D0D] px-5 py-2 border border-[#222222] rounded-full shadow-inner">
            <Zap size={14} className="text-amber-500" />
            Context Compaction ♻️ 1.2k tokens saved
          </div>
        </div>

        {/* Active Node */}
        <div className="flex justify-center relative pb-12">
          <div className="bg-[#111111] border border-blue-500/50 p-5 w-96 shadow-[0_0_30px_rgba(59,130,246,0.15)] relative z-10 rounded-sm">
            <div className="flex items-center gap-2 mb-3 text-blue-400 text-xs font-medium uppercase tracking-wider">
              <Activity size={14} />
              <span>ACTIVE BRANCH: sonnet-3.5</span>
              <div className="ml-auto w-2 h-2 rounded-full bg-blue-500 animate-pulse shadow-[0_0_10px_rgba(59,130,246,0.8)]" />
            </div>
            <p className="text-base leading-relaxed text-blue-50">Analyzing IPC batching results: Latency reduced by 40%.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
