import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Copy, FileText, Image as ImageIcon, Layers,
  Maximize2, MessageSquareText, Minimize2, Pencil, RefreshCw, Repeat2, Sparkles, Target, TriangleAlert } from 'lucide-react';
import { Markdown } from '@noted/claude-blocks';
import { CUSTOM_ICONS } from '../../assets/icons/registry';
import scDesktopIcon from '../../assets/sc-desktop.png';
import { HistoryPromptSource } from './TabMessageSourceChip';
import { timelineFinalPreview, timelineGroupPreview, timelinePreviewModelLabel,
  timelineAutomaticPromptVariant, timelinePromptPreview, timelineResearchModelLabel } from '../../utils/timelineEntryPreview.mjs';
import './TimelineEntryPreview.css';

const fingerprint = (text: string) => window.require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
type Props = {
  entry: any; toolType: string; expanded: boolean; responseLines: number; fontSize: number;
  compact?: { text: string; loading: boolean; encrypted: boolean; postTokens?: number };
  group?: { kind: 'orchestration' | 'subagent'; entries: any[] };
  tokenChip?: React.ReactNode; note?: React.ReactNode; researchModel?: any;
  onExpand: () => void; onNavigatePrompt: () => void; onNavigateAnswer: () => void;
  onSourceNavigate: () => void; onCopy: (text: string) => void;
  loadResponse: (preview: any) => Promise<string>;
  loadImages: (entry: any) => Promise<any[]>;
};

function Attachment({ part }: { part: any }) {
  const [open, setOpen] = useState(false);
  const paste = part.kind === 'paste', image = part.kind === 'image';
  const chip = part.chip || {};
  const update = !!chip.contextUpdateId;
  const Icon = paste ? Layers : image ? ImageIcon : update ? RefreshCw : chip.attachmentKind === 'file' ? FileText : Sparkles;
  const text = paste ? part.text : chip.text;
  const label = paste ? `Pasted Content · ${String(text || '').length.toLocaleString()}`
    : image ? `Image #${part.id || 1}` : chip.label || 'PROMPT';
  const filePath = image ? part.ref?.path : null;
  return <div className="timeline-preview-attachment" data-timeline-preview-attachment={paste ? 'paste' : image ? 'image' : update ? 'context-update' : 'prompt'}>
    <button type="button" className="timeline-preview-attachment-toggle" aria-expanded={open}
      onClick={() => setOpen(value => !value)} title={label}>
      <span className="timeline-preview-attachment-icon"><Icon size={12} /></span>
      <span className="timeline-preview-attachment-label">{label}</span>
      {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
    </button>
    {open && <div className="timeline-preview-attachment-body">
      {image ? filePath ? <img src={`file://${filePath}`} alt={label} />
        : <span>{part.error || part.ref?.error || 'Изображение недоступно'}</span>
        : <span>{String(text || '')}</span>}
    </div>}
  </div>;
}

/** One popup-owned scroll area. No History geometry/scroll writer; full text
 * reads happen only for explicit disclosure of a bounded final preview. */
export function TimelineEntryPreview(props: Props) {
  const { entry, expanded, responseLines, compact, group } = props;
  const imageKey = JSON.stringify([entry.uuid, entry.sourceIdentity, entry.contentRevision, entry.timestamp]);
  const [imageDetails, setImageDetails] = useState<{ key: string; refs: any[] } | null>(null);
  const imageRefs = entry.imagePaths?.length ? entry.imagePaths
    : imageDetails?.key === imageKey ? imageDetails.refs : entry.imagePaths;
  const prompt = useMemo(() => group ? { service: null, source: null, parts: [], text: '' }
    : timelinePromptPreview({ ...entry, imagePaths: imageRefs }, fingerprint), [entry, imageRefs, !!group]);
  const needsImageDetails = !!entry.hasImage && prompt.parts.some((part: any) => part.kind === 'image' && !part.ref?.path);
  useEffect(() => {
    if (!expanded || !needsImageDetails || group || imageDetails?.key === imageKey) return;
    let cancelled = false;
    void props.loadImages(entry).then(refs => {
      if (!cancelled) setImageDetails({ key: imageKey, refs });
    }).catch(() => { if (!cancelled) setImageDetails({ key: imageKey, refs: [] }); });
    return () => { cancelled = true; };
  }, [expanded, needsImageDetails, imageKey, imageDetails?.key, props.loadImages, !!group]);
  const preview = timelineFinalPreview(entry);
  const descriptorKey = preview ? JSON.stringify([preview.uuid, preview.sourceIdentity, preview.contentRevision,
    preview.contentHash, preview.contentLength, preview.content]) : '';
  const [fullResponse, setFullResponse] = useState<{ key: string; text?: string; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [docsOpen, setDocsOpen] = useState<'edited' | 'searched' | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null), contentsRef = useRef<HTMLDivElement>(null);
  const boundaryRef = useRef<HTMLHRElement>(null);
  const [boundary, setBoundary] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    if (!expanded || !preview?.truncated || group) return;
    let cancelled = false;
    setFullResponse(null);
    props.loadResponse(preview).then(text => {
      if (!cancelled) setFullResponse({ key: descriptorKey, text });
    }).catch(error => {
      if (!cancelled) setFullResponse({ key: descriptorKey, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [expanded, descriptorKey, props.loadResponse, !!group]);

  const answer = expanded && fullResponse?.key === descriptorKey && fullResponse.text !== undefined
    ? fullResponse.text : preview?.content || '';
  const responseError = fullResponse?.key === descriptorKey ? fullResponse.error : null;
  const responseLoading = expanded && preview?.truncated && fullResponse?.key !== descriptorKey;
  const docs = group ? timelineGroupPreview(group.entries, group.kind).docs
    : { edited: Array.from(new Set<string>(entry.docsEdited || [])), searched: Array.from(new Set<string>(entry.docsSearchQueries || [])) };

  useLayoutEffect(() => {
    const viewport = viewportRef.current, contents = contentsRef.current;
    if (!expanded || !viewport || !contents || !boundaryRef.current) { setBoundary(null); return; }
    const measure = () => {
      const marker = boundaryRef.current;
      if (!marker || contents.scrollHeight <= viewport.clientHeight) { setBoundary(null); return; }
      // The tick names the document boundary along the scrollbar track, not
      // the thumb or a clickable navigation control. No per-frame polling.
      setBoundary(Math.min(viewport.clientHeight - 2, Math.max(2,
        marker.offsetTop / contents.scrollHeight * viewport.clientHeight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(contents);
    return () => observer.disconnect();
  }, [expanded, answer, descriptorKey]);

  const copy = () => {
    const text = compact ? compact.text : entry.content;
    if (!text) return;
    props.onCopy(text); setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };
  const normal = entry.type === 'user' && !entry.isCompactSummary && !entry.isSubAgent && !entry.isSubAgentTimeout && !prompt.goal;
  const service = prompt.service;
  const sc = service?.runKind === 'external-research';
  const scModel = timelineResearchModelLabel(props.researchModel);
  const source = sc && prompt.source?.researchRunId ? { ...prompt.source, label: scModel || 'Research' } : prompt.source;
  const nativeMcp = !!service && !sc;
  const model = timelinePreviewModelLabel(entry, props.toolType);
  const automatic = service ? null : timelineAutomaticPromptVariant(entry);
  const kind = compact ? 'compact' : entry.type === 'continued' ? 'continued'
    : entry.isSubAgentTimeout ? 'timeout' : entry.isSubAgent ? 'agent'
    : prompt.questionReply ? 'question-reply'
    : service ? sc ? 'research' : 'mcp' : prompt.goal ? prompt.goal.kind === 'status' ? 'goal-status' : 'goal'
    : automatic ? automatic.kind : entry.isGoalContinuation ? 'goal'
    : entry.isPlan ? 'plan' : 'iteration';
  const Icon = kind === 'compact' || kind === 'continued' || kind === 'loop' ? Repeat2 : kind === 'system' || kind === 'continue' ? RefreshCw : kind === 'agent' ? Bot
    : kind === 'timeout' ? TriangleAlert : kind === 'mcp' ? Layers : kind === 'goal' || kind === 'goal-status' ? Target : MessageSquareText;
  const title = compact ? compact.encrypted ? 'context compacted (encrypted)' : 'context compacted'
    : prompt.questionReply ? prompt.questionReply.title
    : kind === 'continued' ? 'Context Overflow Recovery' : kind === 'timeout' ? 'Timeout'
    : kind === 'agent' ? entry.subAgentName || 'Agent' : prompt.goal ? prompt.goal.title : automatic ? automatic.title : kind === 'goal' ? 'Goal continuation'
    : kind === 'plan' ? 'Plan Mode' : kind === 'mcp' ? service?.kind === 'tab-message'
      ? service.phase === 'reply' ? 'Terminal MCP reply' : 'Terminal MCP question'
      : `Terminal MCP ${service?.phase || 'prompt'}` : kind === 'research' ? 'SC Desktop' : 'User mess.';
  const timeValue = entry.timestamp && Number.isFinite(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toLocaleTimeString() : '';
  const attachmentParts = prompt.parts.filter((part: any) => part.kind !== 'text');
  const showBody = !compact?.encrypted;
  const docsOnly = entry.type === 'docs_edit' || entry.type === 'docs_search';
  const canExpand = showBody && (!!prompt.research?.needsDisclosure || !!preview || prompt.text.length > 80 || attachmentParts.length > 0 || !!compact?.text);

  if (group) {
    const aggregate = timelineGroupPreview(group.entries, group.kind);
    return <div className="timeline-entry-preview timeline-entry-preview--group" data-timeline-preview="group" style={{ fontSize: props.fontSize }}>
      <div className="timeline-preview-group-counters">
        {group.kind === 'subagent' ? <><Bot size={12} /><span>Agents · {aggregate.count - aggregate.failed}</span>
          {aggregate.failed > 0 && <span className="timeline-preview-timeout">Timeout · {aggregate.failed}</span>}</>
          : <>{aggregate.mcp > 0 && <><Layers size={12} /><span>Terminal MCP · {aggregate.mcp}</span></>}
            {aggregate.sc > 0 && <><img src={scDesktopIcon} alt="" width={14} height={14} /><span>SC · {aggregate.sc}</span></>}</>}
        <DocsCounters docs={docs} />
      </div>
    </div>;
  }

  return <div className={`timeline-entry-preview${prompt.questionReply ? ' timeline-entry-preview--question-reply' : kind === 'loop' ? ' timeline-entry-preview--loop' : kind === 'continue' ? ' timeline-entry-preview--continue' : ''}`} data-timeline-preview={kind} data-timeline-preview-expanded={expanded}
    data-timeline-preview-user={entry.uuid} data-timeline-preview-final={preview?.uuid}
    style={{ fontSize: props.fontSize }} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <header className="timeline-preview-header">
      {sc ? <img className="timeline-preview-sc-icon" src={scDesktopIcon} alt="SC Desktop" />
        : docsOnly ? null
        : source ? null : <span className={`timeline-preview-kind timeline-preview-kind--${kind}`} title={title}>
          <Icon size={12} /><span>{title}</span>
        </span>}
      {source && <HistoryPromptSource source={source} phase={service?.phase} onNavigate={props.onSourceNavigate} />}
      {nativeMcp && !source && <span className="timeline-preview-channel" title="Terminal MCP">◆</span>}
      <DocsCounters docs={docs} onToggle={value => setDocsOpen(current => current === value ? null : value)} />
      <div className="timeline-preview-header-actions">
        {(!compact || !compact.encrypted && compact.text) && <button type="button" className="timeline-preview-action" title={copied ? 'Скопировано' : 'Копировать исходный текст'}
          aria-label={copied ? 'Скопировано' : 'Копировать исходный текст'} onClick={copy}>
          {copied ? <Check size={14} color="#4ade80" /> : <Copy size={14} />}
        </button>}
        {(canExpand || expanded) && <button type="button" className="timeline-preview-action"
          aria-label={expanded ? 'Свернуть превью' : 'Развернуть превью'} title={expanded ? 'Свернуть' : 'Развернуть полностью'}
          onClick={props.onExpand} aria-expanded={expanded}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>}
      </div>
    </header>
    {showBody && <div className="timeline-preview-reading-frame">
      <div ref={viewportRef} className={`timeline-preview-viewport${expanded ? ' timeline-preview-viewport--expanded' : ''}`}
        data-timeline-preview-scroll={expanded ? 'expanded' : 'collapsed'}>
        <div ref={contentsRef} className="timeline-preview-contents">
          {props.note}
          {docsOpen && <div className="timeline-preview-doc-list">{docs[docsOpen].map((value: string) => <div key={value}>{value}</div>)}</div>}
          {!docsOnly && (expanded ? <div className="timeline-preview-prompt-expanded" data-timeline-preview-prompt>
            {compact ? compact.loading ? <span role="status">Загружаю compact summary…</span>
              : <Markdown text={compact.text || 'Compact summary не найден'} />
              : prompt.research ? <>
                {prompt.parts.slice(0, -1).map((part: any, index: number) => part.kind === 'text'
                  ? <span key={index} className="timeline-preview-prompt-text">{part.text}</span>
                  : <Attachment key={index} part={part} />)}
                <Markdown text={prompt.research.displayText} />
              </> : prompt.parts.map((part: any, index: number) => part.kind === 'text'
                ? <span key={index} className="timeline-preview-prompt-text">{part.text}</span>
                : <Attachment key={index} part={part} />)}
          </div> : <>
            {attachmentParts.length > 0 && <div className="timeline-preview-attachment-band">
              {attachmentParts.map((part: any, index: number) => <span key={index} className="timeline-preview-attachment-collapsed" title={part.chip?.label || part.kind}>
                {part.kind === 'paste' ? <Layers size={11} /> : part.kind === 'image' ? <ImageIcon size={11} />
                  : part.chip?.contextUpdateId ? <RefreshCw size={11} /> : part.chip?.attachmentKind === 'file' ? <FileText size={11} /> : <Sparkles size={11} />}
                <span>{part.kind === 'paste' ? 'Pasted Content' : part.kind === 'image' ? `Image #${part.id || 1}` : part.chip?.label || 'PROMPT'}</span>
              </span>)}
            </div>}
            {(compact || prompt.text) && <div className={`timeline-preview-prompt-collapsed${prompt.research ? ' timeline-preview-research-collapsed' : ''}`} data-timeline-preview-prompt
              role={normal && !compact ? 'button' : undefined} tabIndex={normal && !compact ? 0 : undefined}
              onClick={normal && !compact ? props.onNavigatePrompt : undefined}
              onKeyDown={event => { if (normal && !compact && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); props.onNavigatePrompt(); } }}
              style={normal && !compact ? { cursor: 'pointer' } : undefined}>
              {compact ? compact.loading ? 'Загружаю compact summary…' : compact.text || 'Compact summary не найден' : prompt.text}
            </div>}
          </>)}
          {preview && <>
            {expanded && <hr ref={boundaryRef} className="timeline-preview-boundary" data-timeline-preview-boundary />}
            <div className={`timeline-preview-answer${expanded ? '' : ' timeline-preview-answer--collapsed'}`}
              data-timeline-preview-answer role={expanded ? undefined : 'button'} tabIndex={expanded ? undefined : 0}
              onClick={expanded ? undefined : props.onNavigateAnswer}
              onKeyDown={event => { if (!expanded && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); props.onNavigateAnswer(); } }}
              style={expanded ? undefined : { WebkitLineClamp: responseLines, cursor: 'pointer' }}>
              {expanded ? <Markdown text={answer} /> : answer}
            </div>
            {responseLoading && <span className="timeline-preview-load" role="status">Загружаю полный ответ…</span>}
            {responseError && <span className="timeline-preview-load" role="alert">{responseError}</span>}
          </>}
          {docsOnly && <div className="timeline-preview-doc-list">
            {(entry.type === 'docs_edit' ? docs.edited : docs.searched).map(value => <div key={value}>{value}</div>)}
          </div>}
        </div>
      </div>
      {expanded && boundary !== null && <span className="timeline-preview-scroll-boundary" data-timeline-preview-scroll-boundary style={{ top: boundary }} />}
    </div>}
    <footer className="timeline-preview-footer">
      {timeValue && <time title={entry.timestamp}>{timeValue}</time>}
      {compact ? Number.isFinite(compact.postTokens) && compact.postTokens! > 0 && <span>{compact.postTokens!.toLocaleString()} tokens</span> : props.tokenChip}
      {!sc && model && <span className="timeline-preview-model" title={model.text}>
        {model.icon && <span className="timeline-preview-model-icon">{CUSTOM_ICONS[model.icon]}</span>}
        <span>{model.text}</span>
      </span>}
    </footer>
  </div>;
}

function DocsCounters({ docs, onToggle }: { docs: { edited: string[]; searched: string[] }; onToggle?: (kind: 'edited' | 'searched') => void }) {
  return <span className="timeline-preview-doc-counters">
    {(['edited', 'searched'] as const).map(kind => docs[kind].length > 0 && <button type="button" key={kind}
      className={`timeline-preview-doc-counter timeline-preview-doc-counter--${kind}`}
      title={docs[kind].join('\n')} aria-label={`${kind === 'edited' ? 'Изменённые документы' : 'Поиск документов'}: ${docs[kind].length}`}
      onClick={onToggle ? () => onToggle(kind) : undefined} style={{ cursor: onToggle ? 'pointer' : 'default' }}>
      <Pencil size={11} /><span>{docs[kind].length}</span>
    </button>)}
  </span>;
}
