import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { User as UserIcon } from 'lucide-react';
import CopySessionButton, { ClaudeSparkle } from './CopySessionButton';

// One-line cluster: 📋 CopySessionButton + chip-row (👤 ✦ answer thinking read
// edit bash mcp ⑂fork sub-pill). Reads/writes all copy-flags via useUIStore so
// it's drop-in anywhere — no callbacks needed.
//
// Lives at the right side of ProjectToolbar (top, full-width). Used to be the
// last block of InfoPanel; user moved it out so the toolbar carries the most
// reused session-control affordance.

const CHIP_ON = '#DA7756';
const CHIP_OFF = '#555';

const ChipText = ({ active, children, onClick, title, italic = false, activeColor = CHIP_ON }:
  { active: boolean; children: React.ReactNode; onClick: () => void; title: string; italic?: boolean; activeColor?: string }) => (
  <button
    onClick={onClick}
    title={title}
    className="cursor-pointer hover:opacity-80 transition-opacity"
    style={{
      background: 'transparent', border: 'none', padding: 0,
      color: active ? activeColor : CHIP_OFF,
      fontSize: 9.5,
      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      fontStyle: italic ? 'italic' : 'normal',
      lineHeight: 1.2,
      letterSpacing: '-0.01em',
    }}
  >{children}</button>
);

export default function CopySessionWithChips() {
  // Active session resolution (sub-agent aware via getEffectiveTabId).
  const activeTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const sessionType = useWorkspaceStore((s) => {
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t) {
        if (t.claudeSessionId) return 'claude' as const;
        if (t.geminiSessionId) return 'gemini' as const;
        if (t.codexSessionId) return 'codex' as const;
        return null;
      }
    }
    return null;
  });

  const includeUser = useUIStore((s) => s.copyIncludeUser);
  const includeClaude = useUIStore((s) => s.copyIncludeClaude);
  const includeText = useUIStore((s) => s.copyIncludeText);
  const includeThinking = useUIStore((s) => s.copyIncludeThinking);
  const includeReading = useUIStore((s) => s.copyIncludeReading);
  const includeEditing = useUIStore((s) => s.copyIncludeEditing);
  const includeBash = useUIStore((s) => s.copyIncludeBash);
  const includeTools = useUIStore((s) => s.copyIncludeTools);
  const includeWebSearch = useUIStore((s) => s.copyIncludeWebSearch);
  const includeToolSearch = useUIStore((s) => s.copyIncludeToolSearch);
  const includeOtherTools = useUIStore((s) => s.copyIncludeOtherTools);
  const includeSubagentResult = useUIStore((s) => s.copyIncludeSubagentResult);
  const includeSubagentHistory = useUIStore((s) => s.copyIncludeSubagentHistory);
  const setCopyIncludeUser = useUIStore((s) => s.setCopyIncludeUser);
  const setCopyIncludeClaude = useUIStore((s) => s.setCopyIncludeClaude);
  const setCopyIncludeText = useUIStore((s) => s.setCopyIncludeText);
  const setCopyIncludeThinking = useUIStore((s) => s.setCopyIncludeThinking);
  const setCopyIncludeReading = useUIStore((s) => s.setCopyIncludeReading);
  const setCopyIncludeEditing = useUIStore((s) => s.setCopyIncludeEditing);
  const setCopyIncludeBash = useUIStore((s) => s.setCopyIncludeBash);
  const setCopyIncludeTools = useUIStore((s) => s.setCopyIncludeTools);
  const setCopyIncludeWebSearch = useUIStore((s) => s.setCopyIncludeWebSearch);
  const setCopyIncludeToolSearch = useUIStore((s) => s.setCopyIncludeToolSearch);
  const setCopyIncludeOtherTools = useUIStore((s) => s.setCopyIncludeOtherTools);
  const setCopyIncludeSubagentResult = useUIStore((s) => s.setCopyIncludeSubagentResult);
  const setCopyIncludeSubagentHistory = useUIStore((s) => s.setCopyIncludeSubagentHistory);
  const fromStart = useUIStore((s) => s.copyFromStart);
  const setCopyFromStart = useUIStore((s) => s.setCopyFromStart);
  const [subPreferred, setSubPreferred] = useState<'result' | 'full'>('result');

  if (!activeTabId || !sessionType) return null;

  const isCodex = sessionType === 'codex';
  const ON = isCodex ? '#10A37F' : CHIP_ON;
  const OFF = CHIP_OFF;
  const dot = <span style={{ color: '#333', fontSize: 10, lineHeight: 1.2 }}>·</span>;

  const subOn = includeSubagentResult || includeSubagentHistory;
  const isFull = includeSubagentHistory;
  const sideColor = subOn ? ON : OFF;
  const rightLabel = subOn ? (isFull ? 'full' : 'result') : subPreferred;

  return (
    <div className="flex items-center select-none" style={{ gap: 8 }}>
      <CopySessionButton activeTabId={activeTabId} sessionType={sessionType} />
      {sessionType !== 'gemini' && (
        // Two rows so the chip cluster doesn't stretch the ProjectToolbar.
        // Row 1 = роли / контент Claude (user, claude, answer, thinking).
        // Row 2 = инструменты + scope (read, edit, bash, mcp, ⑂fork, sub-pill).
        <div className="flex flex-col select-none" style={{ gap: 2 }}>
          {/* Row 1 */}
          <div className="flex items-center" style={{ gap: '2px 4px' }}>
            <button
              onClick={() => setCopyIncludeUser(!includeUser)}
              className="cursor-pointer hover:opacity-80 transition-opacity inline-flex items-center"
              style={{ background: 'transparent', border: 'none', padding: 0, lineHeight: 1, color: includeUser ? ON : OFF }}
              title="👤 user prompts"
            >
              <UserIcon size={11} strokeWidth={2} />
            </button>
            {dot}
            <button
              onClick={() => setCopyIncludeClaude(!includeClaude)}
              className="cursor-pointer hover:opacity-80 transition-opacity inline-flex items-center"
              style={{ background: 'transparent', border: 'none', padding: 0, lineHeight: 1 }}
              title="✦ Claude messages"
            >
              {isCodex
                ? <span style={{ color: includeClaude ? ON : OFF, fontSize: 9.5, fontFamily: 'ui-monospace, SFMono-Regular, monospace', lineHeight: 1.2 }}>Codex</span>
                : <ClaudeSparkle size={11} color={includeClaude ? ON : OFF} />}
            </button>
            {dot}
            <ChipText
              italic
              activeColor={ON}
              active={includeClaude && includeText}
              onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeText(!(includeClaude && includeText)); }}
              title="«answer» — финальные ответы агента"
            >answer</ChipText>
            {dot}
            {!isCodex && (
              <ChipText
                italic
                activeColor={ON}
                active={includeClaude && includeThinking}
                onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeThinking(!(includeClaude && includeThinking)); }}
                title="«thinking» — extended thinking blocks"
              >thinking</ChipText>
            )}
          </div>

          {/* Row 2 */}
          <div className="flex items-center" style={{ gap: '2px 4px' }}>
            {!isCodex && (
              <>
                <ChipText
                  activeColor={ON}
                  active={includeClaude && includeReading}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeReading(!(includeClaude && includeReading)); }}
                  title="read_file — Read tool"
                >read</ChipText>
                {dot}
              </>
            )}
            <ChipText
              activeColor={ON}
              active={includeClaude && includeEditing}
              onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeEditing(!(includeClaude && includeEditing)); }}
              title={isCodex ? 'apply_patch' : 'edit, write'}
            >{isCodex ? 'patch' : 'edit'}</ChipText>
            {dot}
            <ChipText
              activeColor={ON}
              active={includeClaude && includeBash}
              onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeBash(!(includeClaude && includeBash)); }}
              title={isCodex ? 'exec_command, write_stdin — shell-команды' : 'bash, monitor, grep, glob — shell-команды'}
            >{isCodex ? 'shell' : 'bash'}</ChipText>
            {dot}
            <ChipText
              activeColor={ON}
              active={includeClaude && includeTools}
              onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeTools(!(includeClaude && includeTools)); }}
              title="mcp__*"
            >mcp</ChipText>
            {dot}
            <ChipText
              activeColor={ON}
              active={includeClaude && includeWebSearch}
              onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeWebSearch(!(includeClaude && includeWebSearch)); }}
              title="web_search"
            >web</ChipText>
            {dot}
            {isCodex && (
              <>
                <ChipText
                  activeColor={ON}
                  active={includeClaude && includeToolSearch}
                  onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeToolSearch(!(includeClaude && includeToolSearch)); }}
                  title="tool_search"
                >tool</ChipText>
                {dot}
              </>
            )}
            <ChipText
              activeColor={ON}
              active={includeClaude && includeOtherTools}
              onClick={() => { if (!includeClaude) setCopyIncludeClaude(true); setCopyIncludeOtherTools(!(includeClaude && includeOtherTools)); }}
              title="other_tools"
            >other</ChipText>
            {dot}
            {!isCodex && (
              <>
                <button
                  onClick={() => setCopyFromStart(!fromStart)}
                  className="cursor-pointer hover:opacity-80 transition-opacity inline-flex items-center"
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    color: !fromStart ? '#3b82f6' : OFF,
                    fontSize: 9.5,
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    lineHeight: 1.2,
                    gap: 3,
                  }}
                  title="Fork starting point: from fork (blue) / from start (grey)"
                >
                  <span style={{ fontSize: 10, lineHeight: 1 }}>⑂</span>
                  <span>fork</span>
                </button>
                {dot}
              </>
            )}
            <span
              className="inline-flex items-center"
              style={{ fontSize: 9.5, fontFamily: 'ui-monospace, SFMono-Regular, monospace', lineHeight: 1.2 }}
            >
              <button
                onClick={() => {
                  if (subOn) {
                    setCopyIncludeSubagentResult(false);
                    setCopyIncludeSubagentHistory(false);
                  } else if (subPreferred === 'full') {
                    setCopyIncludeSubagentHistory(true);
                    setCopyIncludeSubagentResult(false);
                  } else {
                    setCopyIncludeSubagentResult(true);
                    setCopyIncludeSubagentHistory(false);
                  }
                }}
                className="cursor-pointer hover:opacity-80 transition-opacity"
                style={{ background: 'transparent', border: 'none', padding: 0, color: sideColor, fontSize: 9.5, fontFamily: 'inherit', lineHeight: 1.2 }}
              >sub-</button>
              <button
                onClick={() => {
                  if (!subOn) {
                    setSubPreferred(subPreferred === 'result' ? 'full' : 'result');
                  } else if (isFull) {
                    setCopyIncludeSubagentHistory(false);
                    setCopyIncludeSubagentResult(true);
                    setSubPreferred('result');
                  } else {
                    setCopyIncludeSubagentResult(false);
                    setCopyIncludeSubagentHistory(true);
                    setSubPreferred('full');
                  }
                }}
                className="cursor-pointer hover:opacity-80 transition-opacity"
                style={{ background: 'transparent', border: 'none', padding: 0, color: sideColor, fontSize: 9.5, fontFamily: 'inherit', lineHeight: 1.2 }}
              >{rightLabel}</button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
