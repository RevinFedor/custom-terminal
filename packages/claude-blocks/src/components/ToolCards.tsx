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
import { ConversationMessage } from './ConversationMessage';
import { DiffView } from './DiffView';
import { FileTextIcon, FileEditIcon, toolIcon } from '../icons';
import {
  detectLanguage, lineDiff, countDiffStats, resultToText, toolStatusFrom,
  type DiffEntry, type DiffHunk, type ToolStatus,
} from '../helpers';

/**
 * Injection every card forwards to ToolCard verbatim: collapse persistence
 * (host-owned) plus the hover copy hook. They travel together because every
 * card already spreads this one object — a second channel would mean editing
 * six card signatures for one button.
 */
export interface CollapseInjection {
  open?: boolean;
  onToggle?: () => void;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
  getCopyText?: () => string;
  onCopy?: (text: string) => void;
}

/**
 * Header grammar computed by the HOST's parser (see
 * `src/shared/history-action-grammar`): the meaning of the call, split into
 * the one-word verb, the subject it touched and an optional qualifier. The
 * package intentionally does not derive this itself — it must stay portable
 * (mobile-web consumes it too) and free of app-side modules — but rendering a
 * raw `sed -n '500,560p' …` as the row label is forbidden, so hosts that have
 * the grammar inject it here.
 */
export interface ActionHeadline {
  verb: string;
  subject: string;
  detail?: string;
}

const HL_FONT = { style: { fontFamily: 'inherit' } } as const;

/**
 * Highlighting is not slow because it tokenises — it is slow because it emits
 * one wrapper element per coloured token, and those thousands of nodes get
 * laid out inside a box that shows ~15 lines. Measured (E2E ct-e2e14 §2.4):
 * a 29KB / 6000-line `seq` output cost 2.27s of main-thread work on expand
 * with the payload ALREADY in memory, repeating on every re-expand; the plain
 * path brought that to 95ms (verified ct-e2e15).
 *
 * Why not defer offscreen parts here, the way `DiffView` does? Deferral needs
 * per-row block elements the browser can individually skip. This output is one
 * flat run of inline token spans — there are no rows to skip, so the entire
 * blob is built either way. A diff has real rows; a highlighted blob does not.
 *
 * Threshold deliberately equals the dehydration threshold in
 * `history-payload-dehydrate.js`: content too big to ship eagerly is also too
 * big to tokenise. Past it the plain <pre> path renders the identical text
 * (same mono font, same scroll box, one text node instead of thousands of
 * elements) and only trades syntax colours — a readability aid — for a card
 * that opens now. Real source files stay under it and keep highlighting.
 */
const HIGHLIGHT_MAX_CHARS = 16 * 1024;

// Portable fallback for consumers that do not inject the host grammar.
// Ordinary files speak by basename; docs retain the useful tail from docs/.
// Identity and expanded paths remain the untouched `path` value.
const toolHeaderPath = (value: string): string => {
  const text = String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (!text) return '';
  const parts = text.split('/').filter(Boolean);
  if (parts.length === 0) return text;
  const docsIndex = parts.findIndex((part) => part.toLowerCase() === 'docs');
  return docsIndex >= 0
    ? parts.slice(docsIndex).join('/')
    : (parts[parts.length - 1] || text);
};

const FALLBACK_SEARCH_PROGRAMS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'ls', 'tree', 'which',
  'whereis', 'locate', 'ag',
]);
const fallbackShellProgram = (command: string): string => {
  const match = String(command || '').trim().match(/^\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*([^\s;&|]+)/);
  return match ? (match[1].split('/').pop() || '').toLowerCase() : '';
};

const PlainOutput: React.FC<{ text: string; maxHeight: number; topBorder?: boolean }> =
({ text, maxHeight, topBorder }) => (
  <pre
    className="cb-plain-out"
    style={{
      maxHeight,
      marginTop: topBorder ? 6 : 0,
      paddingTop: 6,
      borderTop: topBorder ? '1px solid var(--cb-tool-border)' : undefined,
    }}
  >
    {text}
  </pre>
);

/**
 * The invocation line inside an expanded body: dim, prefixed with `$`, one
 * visual step below the result it produced. Without it a header and its output
 * read as one undifferentiated blob of text — the exact complaint that a
 * `git diff` card looked like "small difference in text" rather than
 * "this is what I ran / this is what came back".
 *
 * Reads never render it: the header already names the file and the line
 * window, and the `sed -n '500,560p'` that produced them is noise.
 */
const InvocationLine: React.FC<{ command: string; description?: string }> = ({ command, description }) => (
  <div className="cb-invocation">
    {description && <div className="cb-bash-desc">{description}</div>}
    <div className="cb-invocation-cmd">
      <span className="cb-invocation-sigil" aria-hidden>$</span>
      <span>{command}</span>
    </div>
  </div>
);

/**
 * Header subject renderer. A path is allowed to WRAP instead of ellipsising:
 * two sibling repos differ only in their trailing segment, so cutting the
 * right edge cut the only distinguishing token. Continuation lines indent to
 * the text column (past the icon), which keeps the icon rail readable.
 */
const HeaderSubject: React.FC<{ text: string; wrap?: boolean; detail?: string }> = ({ text, wrap, detail }) => (
  <span className={wrap ? 'cb-tool-subject cb-tool-subject--wrap' : 'cb-tool-subject'}>
    {text}
    {detail ? <span className="cb-tool-qualifier"> · {detail}</span> : null}
  </span>
);

// ---- Bash ----
const BashCard: React.FC<{ toolName?: string; args: Record<string, any>; result: any; status: ToolStatus; family?: string; headline?: ActionHeadline } & CollapseInjection> =
({ toolName, args, result, status, family, headline: injected, ...collapse }) => {
  const cmd: string = args.command || '';
  const description: string = args.description || '';
  const resultText = resultToText(result);
  // Header says the MEANING and the SUBJECT — never the raw command. A reading
  // Bash is `Read <file> · 500–560`, a git one is `Git diff · Storyboard.tsx`.
  // Only a plain run keeps its command as the subject, because there the
  // command IS what happened. The parser computes this once (shared grammar);
  // the package only renders it, and falls back to a family verb + the raw
  // command for standalone consumers that ship no headline.
  const fallbackProgram = fallbackShellProgram(cmd);
  const fallbackIsSearch = family === 'search'
    || (!family && FALLBACK_SEARCH_PROGRAMS.has(fallbackProgram));
  const headline: ActionHeadline = injected || {
    verb: family === 'read' ? 'Read' : fallbackIsSearch ? 'Search' : family === 'git' ? 'Git' : 'Run',
    // A search pattern is arguments, never a headline. Standalone consumers
    // without the host grammar still get `Search rg`, not the full regex.
    subject: fallbackIsSearch ? (fallbackProgram || 'search') : cmd,
    detail: '',
  };
  const isRun = headline.verb === 'Run';
  const label = headline.verb === 'Run' ? 'Bash' : headline.verb;
  // A sandbox snippet already says everything in its label; its grammar
  // subject is the literal word «script», which next to the label would read
  // «Bash script» — one word said twice.
  const isScript = toolName === 'Script';
  const hasInjectedHeadline = Boolean(injected);
  const subject = isScript ? '' : headline.subject;
  const preview = subject
    ? <HeaderSubject text={subject} wrap={!isRun} detail={headline.detail} />
    // A host-supplied semantic headline is authoritative even when its
    // subject is empty. Falling back to `cmd` here leaked a complete pipeline
    // into collapsed Git/Read/Search rows in grey italics. Raw invocation is
    // a compatibility fallback ONLY for standalone package consumers that
    // supplied no headline at all; History always opens it in the body.
    : ((isScript || hasInjectedHeadline) ? null : <span className="cb-italic-dim">{cmd || '(no command)'}</span>);
  // Reads drop the invocation line entirely (the header already says file and
  // range); every other family keeps it so the call reads apart from the result.
  const showInvocation = !!cmd && headline.verb !== 'Read';
  const body = (showInvocation || resultText) ? (
    <div className="cb-bash-body">
      {showInvocation && <InvocationLine command={cmd} description={description || undefined} />}
      {resultText && (
        resultText.length > HIGHLIGHT_MAX_CHARS ? (
          <PlainOutput text={resultText} maxHeight={180} topBorder={showInvocation} />
        ) : (
          <SyntaxHighlighter
            language="bash"
            style={oneDark as any}
            PreTag="div"
            customStyle={{ margin: showInvocation ? '6px 0 0' : 0, padding: '6px 0 0', background: 'transparent', fontSize: '0.92em', maxHeight: '180px', overflow: 'auto', borderTop: showInvocation ? '1px solid var(--cb-tool-border)' : undefined }}
            codeTagProps={HL_FONT}
          >
            {resultText}
          </SyntaxHighlighter>
        )
      )}
    </div>
  ) : null;
  return <ToolCard status={status} icon={toolIcon('Bash', 13, family)} label={isScript ? 'Script' : label} description={isRun ? (description || undefined) : undefined} preview={preview} body={body} defaultOpen={false} {...collapse} />;
};

// ---- Read ----
const ReadCard: React.FC<{ args: Record<string, any>; result: any; status: ToolStatus; headline?: ActionHeadline } & CollapseInjection> =
({ args, result, status, headline, ...collapse }) => {
  const path: string = args.file_path || args.path || '';
  const lang = detectLanguage(path);
  const raw = resultToText(result);
  const content = raw.replace(/\n+$/, '');
  const lines = content ? content.split('\n') : [];
  const badges = lines.length > 0 ? <span className="cb-read-badge">{lines.length} lines</span> : null;
  const displayPath = headline?.subject || toolHeaderPath(path);
  const preview = path
    ? <HeaderSubject text={displayPath} wrap detail={headline?.detail} />
    : <span className="cb-italic-dim">(no path)</span>;
  const body = content ? (
    content.length > HIGHLIGHT_MAX_CHARS ? (
      <PlainOutput text={content} maxHeight={320} />
    ) : (
      <SyntaxHighlighter
        language={lang}
        style={oneDark as any}
        PreTag="div"
        customStyle={{ margin: 0, padding: '6px 0 0', background: 'transparent', fontSize: '0.92em', maxHeight: '320px', overflow: 'auto' }}
        codeTagProps={HL_FONT}
      >
        {content}
      </SyntaxHighlighter>
    )
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
  headline?: ActionHeadline;
} & CollapseInjection> =
({ toolName, args, status, startLine, diffHunks, headline, ...collapse }) => {
  const path: string = args.file_path || args.path || '';
  const lang = detectLanguage(path);
  const fallbackDiff: DiffEntry[] = React.useMemo(() => {
    // Canonical hunks from the transcript parser make the fallback unused —
    // skip the lineDiff LCS entirely (it ran on every card mount, collapsed
    // or not, for nothing).
    if (Array.isArray(diffHunks) && diffHunks.length > 0) return [];
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
  }, [toolName, args, diffHunks]);
  const canonicalHunks = Array.isArray(diffHunks) && diffHunks.length > 0
    ? diffHunks
    : null;
  const diff = canonicalHunks
    ? canonicalHunks.flatMap(hunk => hunk.entries)
    : fallbackDiff;

  const { added, removed } = countDiffStats(diff);
  // One verb for every file mutation. Update / Write / MultiEdit are three
  // transport names for the same user-visible act ("this file changed"), and
  // showing three different words made a run of edits look like a run of
  // unrelated operations.
  const verb = 'Edit';
  const fileName = headline?.subject || toolHeaderPath(path);
  // Header carries basename (or docs/... for documentation) first, counts
  // AFTER it; the full path lives in the expanded body. Counts are muted at
  // rest and take colour on hover (Codex reference); CSS drives that.
  const stats = (added > 0 || removed > 0) ? (
    <span className="cb-diff-stats">
      {added > 0 && <span className="cb-c-add">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="cb-c-del">−{removed}</span>}
    </span>
  ) : null;
  const preview = fileName
    ? (
      <span className="cb-tool-subject" title={path}>
        {fileName}
        {stats ? <>{'  '}{stats}</> : null}
      </span>
    )
    : <span className="cb-italic-dim">(no path)</span>;
  // Deferral is judged on what the CARD paints, not on one hunk: the card is
  // split into a DiffView per hunk, so a per-hunk test let 38 small hunks
  // (341 rows total) render eagerly while a single 45-row diff got deferred.
  const cardRowCount = canonicalHunks
    ? canonicalHunks.reduce((sum, hunk) => sum + hunk.entries.length, 0)
    : fallbackDiff.length;
  const pathLine = path ? <div className="cb-edit-path">{path}</div> : null;
  const body = canonicalHunks ? (
    <div className="cb-diff-hunks">
      {pathLine}
      {canonicalHunks.map((hunk, index) => (
        <div key={`${hunk.oldStart}:${hunk.newStart}:${index}`} style={{ marginTop: index > 0 ? 4 : 0 }}>
          <DiffView
            entries={hunk.entries}
            language={lang}
            oldStart={hunk.oldStart}
            newStart={hunk.newStart}
            cardRowCount={cardRowCount}
          />
        </div>
      ))}
    </div>
  ) : fallbackDiff.length > 0 ? (
    <div>
      {pathLine}
      <DiffView
        entries={fallbackDiff}
        language={lang}
        startLine={toolName === 'Edit' ? startLine : (toolName === 'Write' ? 1 : undefined)}
        unknownLineNumbers={
          toolName === 'MultiEdit' ||
          (toolName === 'Edit' && !(typeof startLine === 'number' && startLine > 0))
        }
      />
    </div>
  ) : null;
  return <ToolCard status={status} icon={<FileEditIcon size={13} />} label={verb} preview={preview} body={body} defaultOpen={false} {...collapse} />;
};

// ---- MCP (external tool servers) ----
// The visual dictionary forbids the transport name (`mcp__server__method`,
// raw JSON args) as the row label. Header: plug icon + `server · method`;
// args land in the expanded body only.
const McpToolCard: React.FC<{
  toolName: string;
  args: Record<string, any>;
  result: any;
  status: ToolStatus;
  mcpServer?: string;
  mcpMethod?: string;
} & CollapseInjection> =
({ toolName, args, result, status, mcpServer, mcpMethod, ...collapse }) => {
  // Fallback parse for consumers whose host did not stamp identity.
  let server = mcpServer || '';
  let method = mcpMethod || '';
  if (!server && toolName.startsWith('mcp__')) {
    const rest = toolName.slice(5);
    const cut = rest.indexOf('__');
    server = cut > 0 ? rest.slice(0, cut) : rest;
    method = cut > 0 ? rest.slice(cut + 2) : '';
    const redundant = server.toLowerCase() + '_';
    if (method.toLowerCase().startsWith(redundant)) method = method.slice(redundant.length);
  }
  const label = server || 'MCP';
  // Compact one-string argument preview (dim, never the label). `summary`
  // is what Codex normalization writes — but it LEADS with the same
  // `server · method` action this card already prints as its label, so strip
  // that prefix or the header reads `terminal · complete_task terminal ·
  // complete_task` (seen live on first render).
  // Header = «server · method» ONLY. The old dim raw-argument tail (a JS
  // lambda, a tab id, first string of the args object) violated the feed
  // grammar's first law — the header says WHAT, the invocation lives in the
  // body — and its white «…» against grey text made the noise look load-
  // bearing. Codex's human `summary` is a real subject and stays.
  const argPreview = (() => {
    let summary = typeof args?.summary === 'string' ? args.summary : '';
    if (!summary) return '';
    const action = method ? `${server} · ${method.replace(/_/g, ' ')}` : server;
    const actionExact = method ? `${server} · ${method}` : server;
    for (const prefix of [action, actionExact]) {
      if (prefix && summary.toLowerCase().startsWith(prefix.toLowerCase())) {
        summary = summary.slice(prefix.length).replace(/^\s*—\s*/, '').trim();
        break;
      }
    }
    // Backward guard for already-projected/cached rows. Older Codex
    // normalization treated an MCP `prompt` as a short subject and produced
    // `terminal · delegate_to_session — <the complete task>`. A collapsed
    // card then leaked thousands of characters into the feed even though its
    // JSON body was closed. Prompt text is invocation payload: it belongs to
    // the expanded arguments section (and copy), never to the header.
    const rawPrompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
    if (rawPrompt && summary.includes(rawPrompt)) return '';
    return summary;
  })();
  const resultText = result == null ? '' : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  const argsText = args && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '';
  // Body follows the Bash pattern exactly: a dim `$`-style invocation block
  // (the args), a separator, then the result — never two sibling scrollboxes
  // pretending to be one blob under one unbroken rail. Args get a one-screen
  // cap with its own scroll; the result owns the tall area.
  const body = (resultText || argsText) ? (
    <div className="cb-mcp-body">
      {argsText && (
        <div className="cb-mcp-args">
          <div className="cb-mcp-section-label">arguments</div>
          <pre className="cb-generic-out" style={{ maxHeight: 120, padding: 0 }}>{argsText}</pre>
        </div>
      )}
      {resultText && (
        <div className={argsText ? 'cb-mcp-result' : undefined}>
          {argsText && <div className="cb-mcp-section-label">result</div>}
          <pre className="cb-generic-out">{resultText}</pre>
        </div>
      )}
    </div>
  ) : null;
  return (
    <ToolCard
      status={status}
      icon={toolIcon(toolName, 13, 'mcp')}
      label={method ? `${label} · ${method.replace(/_/g, ' ')}` : label}
      preview={argPreview ? <HeaderSubject text={argPreview} wrap /> : null}
      body={body}
      defaultOpen={false}
      {...collapse}
    />
  );
};

// ---- Generic fallback (Glob, Grep, WebSearch, etc.) ----
/**
 * Human form of a transport tool name: `Tool Search` → `Tool search`,
 * `WebSearch` → `Web search`, `complete_task` → `complete task`. One type
 * voice: the feed speaks sentence case everywhere (user decision), so no
 * label may shout its transport spelling.
 */
export function humanToolLabel(name: string): string {
  const spaced = String(name || '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return 'Tool';
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const GenericToolCard: React.FC<{ toolName: string; args: Record<string, any>; result: any; status: ToolStatus; family?: string; headline?: ActionHeadline } & CollapseInjection> =
({ toolName, args, result, status, family, headline, ...collapse }) => {
  const icon = toolIcon(toolName, 13, family);
  const nativeSearch = toolName === 'Grep' || toolName === 'Glob';
  const semanticSearch = headline?.verb === 'Search' || nativeSearch;
  const searchHeadline = headline?.verb === 'Search'
    ? headline
    : nativeSearch
      ? {
          verb: 'Search',
          subject: toolName.toLowerCase(),
          detail: toolHeaderPath(args?.path || args?.glob || ''),
        }
      : undefined;
  const summary = (() => {
    if (semanticSearch) return searchHeadline?.subject || '';
    if (toolName === 'WebSearch' || toolName === 'WebFetch') return args.query || args.url || '';
    if (typeof args === 'object' && args) {
      const first = Object.values(args).find(v => typeof v === 'string') as string | undefined;
      return first ? first.slice(0, 200) : '';
    }
    return '';
  })();
  const resultText = result == null ? '' : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  // Non-search generic subjects (for example a URL) wrap instead of truncating.
  // Search patterns were consumed above as arguments and never reach summary.
  const preview = summary
    ? <HeaderSubject text={summary} wrap detail={semanticSearch ? searchHeadline?.detail : undefined} />
    : null;
  const searchArgsText = semanticSearch && args && Object.keys(args).length > 0
    ? JSON.stringify(args, null, 2)
    : '';
  const body = semanticSearch && (searchArgsText || resultText) ? (
    <div className="cb-mcp-body">
      {searchArgsText && (
        <div className="cb-mcp-args">
          <div className="cb-mcp-section-label">arguments</div>
          <pre className="cb-generic-out" style={{ maxHeight: 120, padding: 0 }}>{searchArgsText}</pre>
        </div>
      )}
      {resultText && (
        <div className={searchArgsText ? 'cb-mcp-result' : undefined}>
          {searchArgsText && <div className="cb-mcp-section-label">result</div>}
          <pre className="cb-generic-out">{resultText}</pre>
        </div>
      )}
    </div>
  ) : resultText ? <pre className="cb-generic-out">{resultText}</pre> : null;
  return <ToolCard status={status} icon={icon} label={semanticSearch ? 'Search' : humanToolLabel(toolName)} preview={preview} body={body} defaultOpen={false} {...collapse} />;
};

/**
 * What a row hands over when its copy button is pressed: the payload in its
 * ORIGINAL form, not the rendering.
 *
 * Per kind, because "the content" means a different thing per kind:
 *  - a read → the file text it shows when expanded;
 *  - a run → the command AND its output, because either alone is half the
 *    story of what happened;
 *  - an edit → the path plus the diff exactly as the transcript recorded it;
 *  - an MCP call → arguments and result, the two halves of the exchange.
 * Nothing to hand over → empty string → no button at all (a control that
 * copies nothing is worse than no control).
 */
function toolCopyText(
  toolName: string,
  args: Record<string, any>,
  result: any,
  diffHunks?: readonly DiffHunk[],
): string {
  const resultText = resultToText(result);
  if (toolName === 'Read') {
    return resultText.replace(/\n+$/, '');
  }
  if (toolName === 'Bash' || toolName === 'Script') {
    const command = typeof args?.command === 'string' ? args.command : '';
    if (command && resultText) return command + '\n\n' + resultText;
    return command || resultText;
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'Update') {
    const path = String(args?.file_path || args?.path || '');
    if (Array.isArray(diffHunks) && diffHunks.length > 0) {
      const diff = diffHunks
        .map((hunk) => hunk.entries
          .map((row: DiffEntry) => (row.tag === 'add' ? '+' : row.tag === 'del' ? '-' : ' ') + row.line)
          .join('\n'))
        .join('\n');
      return path ? path + '\n\n' + diff : diff;
    }
    if (toolName === 'Write' && typeof args?.content === 'string') {
      return path ? path + '\n\n' + args.content : args.content;
    }
    return path;
  }
  const argsText = args && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '';
  if (argsText && resultText) return argsText + '\n\n' + resultText;
  return resultText || argsText;
}

/** Диспетчер: tool-имя → нужная карточка. `collapse` внедряет персист раскрытия. */
export interface ToolCallProps {
  toolName: string;
  args: Record<string, any>;
  result?: any;
  isError?: boolean;
  /** Verified host projection, not classification by tool label/body words.
   * Original args/result still own Copy; this is presentation only. */
  questionReply?: { kind: string; title: string; text: string; items: Array<{ answer: string }> };
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
  /** Parser-stamped grouping family (read/search/git/run/edit/mcp/plan/web).
   *  Refines the icon: a reading Bash gets the file glyph, git its branch. */
  family?: string;
  /** Host-computed header grammar (verb + subject + qualifier). Present, the
   *  row says what was touched; absent, the package falls back to the raw
   *  command. See {@link ActionHeadline}. */
  headline?: ActionHeadline;
  /** Parsed MCP identity — renders `server · method` instead of the transport
   *  name. Hosts that do not stamp it still get the name-parse fallback. */
  mcpServer?: string;
  mcpMethod?: string;
  collapse?: CollapseInjection;
  /** Host clipboard for the row's hover copy button; omitted → no button. */
  onCopy?: (text: string) => void;
}

export const ToolCallPart: React.FC<ToolCallProps> = ({ toolName, args, result, isError, questionReply, startLine, diffHunks, awaitingApproval, family, headline, mcpServer, mcpMethod, collapse, onCopy }) => {
  const status = toolStatusFrom(result, isError, awaitingApproval);
  // Built lazily: a collapsed row must not pay for a string nobody requested,
  // and a dehydrated result would be materialised for nothing.
  const copyInjection = onCopy
    ? { onCopy, getCopyText: () => toolCopyText(toolName, args, result, diffHunks) }
    : {};
  const inj = { ...(collapse || {}), ...copyInjection };
  if (questionReply?.kind === 'question-reply') {
    return <ConversationMessage layout="block" tone="info" className="cb-question-reply-tool">
      <ToolCard status={status} icon={toolIcon(toolName)} label={questionReply.title}
        preview={questionReply.items.map(item => item.answer).join(' / ')}
        body={<div className="cb-msg-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{questionReply.text}</div>}
        {...inj} />
    </ConversationMessage>;
  }
  if (toolName.startsWith('mcp__') || toolName === 'MCP' || family === 'mcp') {
    return (
      <McpToolCard
        toolName={toolName}
        args={args}
        result={result}
        status={status}
        mcpServer={mcpServer}
        mcpMethod={mcpMethod}
        {...inj}
      />
    );
  }
  // `Script` = a JS snippet Codex ran in its sandbox. Same card as a shell run
  // (header names it, body shows the source and the output); only the parser's
  // name differs, because the header grammar must not read JS as a shell line.
  if (toolName === 'Bash' || toolName === 'Script') {
    return <BashCard toolName={toolName} args={args} result={result} status={status} family={family} headline={headline} {...inj} />;
  }
  if (toolName === 'Read') return <ReadCard args={args} result={result} status={status} headline={headline} {...inj} />;
  // A patch that never applied groups WITH the edits (same family) but is not
  // one: the edit card would promise a file and a diff it does not have.
  if (toolName === 'Patch') {
    return <GenericToolCard toolName={toolName} args={args} result={result} status={status} family={family} headline={headline} {...inj} />;
  }
  // `Update` is Codex's name for the same act; it must not become a fourth verb.
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'Update' || family === 'edit') {
    return <EditCard toolName={toolName} args={args} status={status} startLine={startLine} diffHunks={diffHunks} headline={headline} {...inj} />;
  }
  return <GenericToolCard toolName={toolName} args={args} result={result} status={status} family={family} headline={headline} {...inj} />;
};

export { BashCard, ReadCard, EditCard, GenericToolCard, McpToolCard };
