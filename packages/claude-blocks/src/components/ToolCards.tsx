/* ============================================================
   @noted/claude-blocks — специализированные tool-карточки
   ------------------------------------------------------------
   Bash / Read / Edit-Write-MultiEdit / Generic + диспетчер.
   Перенос из ClaudeSDKTab.tsx (канон). Каждая карточка прокидывает
   collapse-пропы (open/onToggle/anchorRef) в ToolCard, чтобы
   потребитель мог внедрить свой персист раскрытия.
   ============================================================ */
import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ToolCard } from './ToolCard';
import { DiffView } from './DiffView';
import { TerminalIcon, FileTextIcon, FileEditIcon, toolIcon } from '../icons';
import {
  detectLanguage, lineDiff, countDiffStats, resultToText, toolStatusFrom,
  type DiffEntry, type DiffHunk, type ToolStatus,
} from '../helpers';

/** Collapse-пропы, общие для всех карточек (потребитель внедряет персист). */
export interface CollapseInjection {
  open?: boolean;
  onToggle?: () => void;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
}

const HL_FONT = { style: { fontFamily: 'inherit' } } as const;

// ---- Bash ----
const BashCard: React.FC<{ args: Record<string, any>; result: any; status: ToolStatus } & CollapseInjection> =
({ args, result, status, ...collapse }) => {
  const cmd: string = args.command || '';
  const description: string = args.description || '';
  const resultText = resultToText(result);
  const preview = cmd ? <span>{cmd}</span> : <span className="cb-italic-dim">(no command)</span>;
  // Expanded body leads with the FULL command (and its description) wrapped, so a
  // header that ellipsised on a narrow screen is always recoverable on expand —
  // not just the output. (Mobile: a long `description (…)` used to push the
  // command off-screen with no way to read it back. Now expand always shows it.)
  const body = (cmd || resultText) ? (
    <div className="cb-bash-body">
      {description && <div className="cb-bash-desc">{description}</div>}
      {cmd && <div className="cb-bash-cmd">{cmd}</div>}
      {resultText && (
        <SyntaxHighlighter
          language="bash"
          style={oneDark as any}
          PreTag="div"
          customStyle={{ margin: (cmd || description) ? '6px 0 0' : 0, padding: '6px 0 0', background: 'transparent', fontSize: '0.92em', maxHeight: '180px', overflow: 'auto', borderTop: (cmd || description) ? '1px solid var(--cb-tool-border)' : undefined }}
          codeTagProps={HL_FONT}
        >
          {resultText}
        </SyntaxHighlighter>
      )}
    </div>
  ) : null;
  return <ToolCard status={status} icon={<TerminalIcon size={13} />} label="Bash" description={description || undefined} preview={preview} body={body} defaultOpen={false} {...collapse} />;
};

// ---- Read ----
const ReadCard: React.FC<{ args: Record<string, any>; result: any; status: ToolStatus } & CollapseInjection> =
({ args, result, status, ...collapse }) => {
  const path: string = args.file_path || args.path || '';
  const lang = detectLanguage(path);
  const raw = resultToText(result);
  const content = raw.replace(/\n+$/, '');
  const lines = content ? content.split('\n') : [];
  const badges = lines.length > 0 ? <span className="cb-read-badge">{lines.length} lines</span> : null;
  const preview = path ? <span>{path}</span> : <span className="cb-italic-dim">(no path)</span>;
  const body = content ? (
    <SyntaxHighlighter
      language={lang}
      style={oneDark as any}
      PreTag="div"
      customStyle={{ margin: 0, padding: '6px 0 0', background: 'transparent', fontSize: '0.92em', maxHeight: '320px', overflow: 'auto' }}
      codeTagProps={HL_FONT}
    >
      {content}
    </SyntaxHighlighter>
  ) : null;
  return <ToolCard status={status} icon={<FileTextIcon size={13} />} label="Read" badges={badges} preview={preview} body={body} defaultOpen={false} {...collapse} />;
};

// ---- Edit / Write / MultiEdit ----
const EditCard: React.FC<{
  toolName: string;
  args: Record<string, any>;
  status: ToolStatus;
  startLine?: number;
  diffHunks?: readonly DiffHunk[];
} & CollapseInjection> =
({ toolName, args, status, startLine, diffHunks, ...collapse }) => {
  const path: string = args.file_path || args.path || '';
  const lang = detectLanguage(path);
  const fallbackDiff: DiffEntry[] = React.useMemo(() => {
    if (toolName === 'Write') {
      const content = (args.content || '') as string;
      return content ? content.split('\n').map(line => ({ tag: 'add' as const, line })) : [];
    }
    if (toolName === 'MultiEdit') {
      const edits: Array<{ old_string?: string; new_string?: string }> = Array.isArray(args.edits) ? args.edits : [];
      const out: DiffEntry[] = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const hunk = lineDiff(e.old_string || '', e.new_string || '');
        if (i > 0) out.push({ tag: 'eq', line: '─'.repeat(40) });
        out.push(...hunk);
      }
      return out;
    }
    return lineDiff(args.old_string || '', args.new_string || '');
  }, [toolName, args]);
  const canonicalHunks = Array.isArray(diffHunks) && diffHunks.length > 0
    ? diffHunks
    : null;
  const diff = canonicalHunks
    ? canonicalHunks.flatMap(hunk => hunk.entries)
    : fallbackDiff;

  const { added, removed } = countDiffStats(diff);
  const verb = toolName === 'Write' ? 'Write' : toolName === 'MultiEdit' ? 'MultiEdit' : 'Update';
  const subtitle = (added > 0 || removed > 0) ? (
    <span className="cb-diff-stats">
      {added > 0 && <>Added <span className="cb-c-add">{added}</span> {added === 1 ? 'line' : 'lines'}</>}
      {added > 0 && removed > 0 && ', '}
      {removed > 0 && <>removed <span className="cb-c-del">{removed}</span> {removed === 1 ? 'line' : 'lines'}</>}
    </span>
  ) : null;
  const preview = path ? <span>{path}</span> : <span className="cb-italic-dim">(no path)</span>;
  const body = canonicalHunks ? (
    <div className="cb-diff-hunks">
      {canonicalHunks.map((hunk, index) => (
        <div key={`${hunk.oldStart}:${hunk.newStart}:${index}`} style={{ marginTop: index > 0 ? 4 : 0 }}>
          <DiffView
            entries={hunk.entries}
            language={lang}
            oldStart={hunk.oldStart}
            newStart={hunk.newStart}
          />
        </div>
      ))}
    </div>
  ) : fallbackDiff.length > 0 ? (
    <DiffView
      entries={fallbackDiff}
      language={lang}
      startLine={toolName === 'Edit' ? startLine : (toolName === 'Write' ? 1 : undefined)}
      unknownLineNumbers={
        toolName === 'MultiEdit' ||
        (toolName === 'Edit' && !(typeof startLine === 'number' && startLine > 0))
      }
    />
  ) : null;
  return <ToolCard status={status} icon={<FileEditIcon size={13} />} label={verb} preview={preview} subtitle={subtitle} body={body} defaultOpen={true} {...collapse} />;
};

// ---- Generic fallback (Glob, Grep, WebSearch, MCP, etc.) ----
const GenericToolCard: React.FC<{ toolName: string; args: Record<string, any>; result: any; status: ToolStatus } & CollapseInjection> =
({ toolName, args, result, status, ...collapse }) => {
  const icon = toolIcon(toolName, 13);
  const summary = (() => {
    if (toolName === 'Glob') return args.pattern || '';
    if (toolName === 'Grep') return args.pattern || '';
    if (toolName === 'WebSearch' || toolName === 'WebFetch') return args.query || args.url || '';
    if (typeof args === 'object' && args) {
      const first = Object.values(args).find(v => typeof v === 'string') as string | undefined;
      return first ? first.slice(0, 200) : '';
    }
    return '';
  })();
  const resultText = result == null ? '' : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  const preview = summary ? <span>{summary}</span> : null;
  const body = resultText ? <pre className="cb-generic-out">{resultText}</pre> : null;
  return <ToolCard status={status} icon={icon} label={toolName} preview={preview} body={body} defaultOpen={false} {...collapse} />;
};

/** Диспетчер: tool-имя → нужная карточка. `collapse` внедряет персист раскрытия. */
export interface ToolCallProps {
  toolName: string;
  args: Record<string, any>;
  result?: any;
  isError?: boolean;
  /** 1-based file line where an Edit's hunk begins — gives the diff gutter REAL
   *  line numbers. The host computes it (it knows where old_string matched);
   *  the package can't recover it after the edit. Omit → gutter is 1..N. */
  startLine?: number;
  /** Canonical unified-diff hunks supplied by the transcript parser. Unlike
   * `startLine`, each hunk keeps independent old/new coordinates. */
  diffHunks?: readonly DiffHunk[];
  /** Gated call paused for the user (host shows approve/deny). Renders the amber
   *  triangle instead of the running spinner. */
  awaitingApproval?: boolean;
  collapse?: CollapseInjection;
}

export const ToolCallPart: React.FC<ToolCallProps> = ({ toolName, args, result, isError, startLine, diffHunks, awaitingApproval, collapse }) => {
  const status = toolStatusFrom(result, isError, awaitingApproval);
  const inj = collapse || {};
  if (toolName === 'Bash') return <BashCard args={args} result={result} status={status} {...inj} />;
  if (toolName === 'Read') return <ReadCard args={args} result={result} status={status} {...inj} />;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return <EditCard toolName={toolName} args={args} status={status} startLine={startLine} diffHunks={diffHunks} {...inj} />;
  }
  return <GenericToolCard toolName={toolName} args={args} result={result} status={status} {...inj} />;
};

export { BashCard, ReadCard, EditCard, GenericToolCard };
