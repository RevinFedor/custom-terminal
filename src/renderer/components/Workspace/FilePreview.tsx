import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useUIStore } from '../../store/useUIStore';
import hljs from 'highlight.js';
import 'highlight.js/styles/vs2015.css';

export default function FilePreview() {
  const { filePreview, closeFilePreview, showToast, fileExplorerOpen } = useUIStore();
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (filePreview && contentRef.current) {
      renderContent();
    }
  }, [filePreview]);

  const renderContent = () => {
    if (!filePreview || !contentRef.current) return;

    const { content, language } = filePreview;

    if (language) {
      try {
        const highlighted = hljs.highlight(content, {
          language,
          ignoreIllegals: true
        });

        const lines = highlighted.value.split('\n');
        const lineNumberWidth = String(lines.length).length;

        const codeHTML = lines.map((line: string, index: number) => {
          const lineNum = String(index + 1).padStart(lineNumberWidth, ' ');
          return `<div class="code-line flex hover:bg-white/5">
            <span class="line-number inline-block text-right pr-4 text-[#666] select-none shrink-0" style="min-width: ${lineNumberWidth + 1}ch">${lineNum}</span>
            <span class="line-content flex-1">${line || ' '}</span>
          </div>`;
        }).join('');

        contentRef.current.innerHTML = `<pre class="hljs-pre !m-0 !p-0 !bg-transparent"><code class="hljs language-${language} !block !p-0 !bg-transparent">${codeHTML}</code></pre>`;
      } catch (e) {
        console.warn('Syntax highlighting failed:', e);
        // Fallback to plain text with line numbers
        const lines = content.split('\n');
        const lineNumberWidth = String(lines.length).length;

        const plainHTML = lines.map((line: string, index: number) => {
          const lineNum = String(index + 1).padStart(lineNumberWidth, ' ');
          const escapedLine = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<div class="code-line flex hover:bg-white/5">
            <span class="line-number inline-block text-right pr-4 text-[#666] select-none shrink-0" style="min-width: ${lineNumberWidth + 1}ch">${lineNum}</span>
            <span class="line-content flex-1">${escapedLine || ' '}</span>
          </div>`;
        }).join('');

        contentRef.current.innerHTML = `<pre class="!m-0 !p-0 !bg-transparent"><code class="!block !p-0 !bg-transparent">${plainHTML}</code></pre>`;
      }
    } else {
      // Plain text with line numbers
      const lines = content.split('\n');
      const lineNumberWidth = String(lines.length).length;

      const plainHTML = lines.map((line: string, index: number) => {
        const lineNum = String(index + 1).padStart(lineNumberWidth, ' ');
        const escapedLine = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div class="code-line flex hover:bg-white/5">
          <span class="line-number inline-block text-right pr-4 text-[#666] select-none shrink-0" style="min-width: ${lineNumberWidth + 1}ch">${lineNum}</span>
          <span class="line-content flex-1">${escapedLine || ' '}</span>
        </div>`;
      }).join('');

      contentRef.current.innerHTML = `<pre class="!m-0 !p-0 !bg-transparent"><code class="!block !p-0 !bg-transparent">${plainHTML}</code></pre>`;
    }
  };

  const handleCopyContent = async () => {
    if (filePreview) {
      await navigator.clipboard.writeText(filePreview.content);
      setCopied(true);
      showToast('Copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Get filename from path
  const fileName = filePreview?.path.split('/').pop() || '';

  if (!filePreview) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.1, ease: 'easeOut' }}
      style={{
        position: 'fixed',
        top: 36,
        left: fileExplorerOpen ? 250 : 0,
        right: 0,
        bottom: 0,
        zIndex: 100000,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1a1a1a',
        border: '1px solid #333'
      }}
    >
      {/* Header */}
      <div className="h-10 bg-tab border-b border-border-main flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-sm font-bold text-white">{fileName}</span>
          <span className="text-[10px] text-[#555] truncate">{filePreview.path}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`text-xs px-2 py-1 rounded transition-colors ${
              copied
                ? 'text-accent bg-accent/10'
                : 'text-[#666] hover:text-accent hover:bg-white/5'
            }`}
            onClick={handleCopyContent}
          >
            {copied ? '✓ Copied' : 'Copy All'}
          </button>
          <button
            className="text-[#999] hover:text-white text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-white/10"
            onClick={closeFilePreview}
          >
            ×
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        className="flex-1 overflow-auto p-4 font-jetbrains text-sm text-[#ddd] leading-relaxed bg-[#1e1e1e]"
      />
    </motion.div>,
    document.body
  );
}
