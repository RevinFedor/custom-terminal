/* ============================================================
   @noted/claude-blocks — Markdown (ответ ассистента + code-block)
   ------------------------------------------------------------
   Перенос из ClaudeSDKTab.tsx::AssistantTextPart + MarkdownCodeBlock.
   Класс .cb-prose несёт font-smoothing-фикс (обычный текст не жирнит).
   Цвета/типографика — через токены theme.css, не инлайн.
   ============================================================ */
import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { rehypeHexHighlight } from '../rehypeHexHighlight';
import { extractRawText, copyText } from '../helpers';
import { selectionToMarkdown } from '../selectionMarkdown';
import { CopyIcon, CheckIcon } from '../icons';

// Block code with a tiny header strip: language label (left) + copy button
// (right). Each block owns its own copy/copied state.
export const MarkdownCodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);
  const displayLang = language || 'text';
  return (
    <div className="cb-code-block">
      <div className="cb-code-head">
        <span className="cb-code-lang">{displayLang}</span>
        <button type="button" onClick={onCopy} className="cb-code-copy" data-copied={copied} title={copied ? 'Copied' : 'Copy'}>
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark as any}
        PreTag="div"
        className="cb-code-scroll"
        customStyle={{
          margin: 0,
          padding: '10px 12px',
          background: 'transparent',
          fontSize: '0.92em',
          lineHeight: 1.5,
          maxHeight: 'var(--cb-markdown-code-max-height, 43.4em)',
          overflowX: 'hidden',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
        codeTagProps={{
          style: {
            fontFamily: 'inherit',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

// On mouse-selection copy inside the rendered prose, override the clipboard
// with a markdown-reconstructed version of the SELECTION (not the whole text)
// — preserves list markers (`- `), heading hashes, blank lines between blocks
// and code fences, which a raw DOM-serialize would drop. Falls through to the
// browser default if the selection escapes the prose or serialization is empty.
// Walk up from the selection's common ancestor to the nearest code container.
// If found, the WHOLE selection sits inside one code block (both endpoints share
// that ancestor) — copy must be the raw code, no ``` fence.
function enclosingCodeBlock(range: Range): HTMLElement | null {
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  if (!el || !el.closest) return null;
  return el.closest('.cb-code-block, pre, code');
}

function handleProseCopy(e: React.ClipboardEvent<HTMLDivElement>) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  // Only act when the selection is (mostly) within THIS prose container.
  const container = e.currentTarget;
  if (!container.contains(range.commonAncestorContainer)) return;

  // Selection ENTIRELY inside one code block → copy raw code, NO fence (user:
  // «выделил три-кликом внутри блока кода — копируется внутренний текст, без
  // троеточек; ``` только при копировании всего чата»). The fence is for
  // distinguishing code from prose in a MIXED selection (handled below by
  // selectionToMarkdown) and for whole-chat copy; an in-block selection is
  // already unambiguously code. range.toString() gives exactly the selected
  // characters with the highlighter's literal newlines preserved.
  if (enclosingCodeBlock(range)) {
    const raw = range.toString();
    if (!raw) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', raw);
    copyText(raw);
    return;
  }

  const md = selectionToMarkdown(range);
  if (!md) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', md);
  // Belt & suspenders: ALSO write through copyText (host-injected IPC →
  // main-process clipboard). clipboardData.setData inside a copy event raised
  // by webContents.copy() (Edit-menu role) did not reliably reach the OS
  // clipboard in the Electron overlay — selecting inside a code block "copied
  // nothing". The IPC write is unconditional and deterministic; worst case the
  // same text lands twice.
  copyText(md);
}

export const Markdown: React.FC<{ text: string }> = ({ text }) => {
  if (!text.trim()) return null;
  return (
    <div className="cb-prose" onCopy={handleProseCopy}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHexHighlight]}
        components={{
          pre({ children }) {
            const codeNode: any = Array.isArray(children) ? children[0] : children;
            const codeProps = codeNode?.props || {};
            const langMatch = /language-(\w+)/.exec(codeProps.className || '');
            const codeString = extractRawText(codeProps.children).replace(/\n$/, '');
            return <MarkdownCodeBlock language={langMatch ? langMatch[1] : ''} code={codeString} />;
          },
          code({ className, children, ...props }) {
            // inline `code` only (block handled in pre). Hue-shift, no pill.
            return <code className={className || ''} {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
