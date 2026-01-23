import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * gt-editor color palette for markdown preview in FilePreview
 */
const colors = {
  bold: '#ffa348',      // Orange
  italic: '#69dbdb',    // Teal/Cyan
  code: '#50fa7b',      // Green
  codeBackground: 'rgba(80, 80, 80, 0.4)',
  strike: '#868e96',    // Gray

  // Headings (purple gradient)
  h1: '#c678dd',
  h2: '#b197fc',
  h3: '#a78bfa',
  h4: '#9775fa',
  h5: '#8b5cf6',
  h6: '#7c3aed',

  // Other
  link: '#89b4fa',      // Accent blue
  blockquoteBorder: '#6c7086',
  hr: 'rgba(255, 255, 255, 0.3)',
};

interface MarkdownPreviewProps {
  content: string;
}

function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Code blocks with syntax highlighting
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';

          if (!inline && language) {
            return (
              <div className="my-2 rounded-lg overflow-hidden" style={{ background: 'rgba(80, 80, 80, 0.25)' }}>
                <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-gray-500" style={{ background: 'rgba(60, 60, 60, 0.4)' }}>
                  <span>{language}</span>
                  <button
                    className="hover:text-gray-300 transition-colors cursor-pointer"
                    onClick={() => navigator.clipboard.writeText(String(children).replace(/\n$/, ''))}
                  >
                    Copy
                  </button>
                </div>
                <SyntaxHighlighter
                  style={oneDark}
                  language={language}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    padding: '12px',
                    fontSize: '13px',
                    lineHeight: 1.5,
                    background: 'rgba(80, 80, 80, 0.25)'
                  }}
                  {...props}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            );
          }

          // Code block without language
          if (!inline) {
            return (
              <pre className="my-2 p-3 rounded-lg overflow-x-auto text-sm" style={{ background: 'rgba(80, 80, 80, 0.25)' }}>
                <code className="text-gray-300" {...props}>
                  {children}
                </code>
              </pre>
            );
          }

          // Inline code - gt-editor style
          return (
            <code
              style={{
                color: colors.code,
                backgroundColor: colors.codeBackground,
                borderRadius: '3px',
                padding: '1px 4px',
                fontSize: '0.9em',
                fontFamily: '"SF Mono", "Fira Code", monospace',
              }}
              {...props}
            >
              {children}
            </code>
          );
        },

        // Paragraphs
        p({ children, node }) {
          const hasBlockChild = node?.children?.some((child: any) =>
            child.tagName === 'pre' || child.tagName === 'div'
          );
          if (hasBlockChild) {
            return <div className="mb-3 last:mb-0">{children}</div>;
          }
          return <p className="mb-3 last:mb-0">{children}</p>;
        },

        // Headers - gt-editor purple gradient
        h1({ children }) {
          return (
            <h1 style={{ color: colors.h1, fontSize: '1.5em', fontWeight: 'bold' }} className="mb-3 mt-4 first:mt-0">
              {children}
            </h1>
          );
        },
        h2({ children }) {
          return (
            <h2 style={{ color: colors.h2, fontSize: '1.3em', fontWeight: 'bold' }} className="mb-2 mt-3 first:mt-0">
              {children}
            </h2>
          );
        },
        h3({ children }) {
          return (
            <h3 style={{ color: colors.h3, fontSize: '1.15em', fontWeight: 'bold' }} className="mb-2 mt-3 first:mt-0">
              {children}
            </h3>
          );
        },
        h4({ children }) {
          return (
            <h4 style={{ color: colors.h4, fontSize: '1.1em', fontWeight: 'bold' }} className="mb-2 mt-2 first:mt-0">
              {children}
            </h4>
          );
        },
        h5({ children }) {
          return (
            <h5 style={{ color: colors.h5, fontWeight: 'bold' }} className="mb-2 mt-2 first:mt-0">
              {children}
            </h5>
          );
        },
        h6({ children }) {
          return (
            <h6 style={{ color: colors.h6, fontWeight: 'bold' }} className="mb-2 mt-2 first:mt-0">
              {children}
            </h6>
          );
        },

        // Lists
        ul({ children }) {
          return <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>;
        },
        li({ children }) {
          return <li className="text-gray-200">{children}</li>;
        },

        // Links - gt-editor accent color
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: colors.link }}
              className="hover:opacity-80 underline"
            >
              {children}
            </a>
          );
        },

        // Blockquotes
        blockquote({ children }) {
          return (
            <blockquote
              style={{ borderLeftColor: colors.blockquoteBorder }}
              className="border-l-2 pl-3 my-2 text-gray-400 italic"
            >
              {children}
            </blockquote>
          );
        },

        // Tables
        table({ children }) {
          return (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th className="border border-[#444] bg-[#333] px-3 py-1.5 text-left font-medium">
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td className="border border-[#444] px-3 py-1.5">{children}</td>
          );
        },

        // Horizontal rule
        hr() {
          return <hr style={{ background: colors.hr, border: 'none', height: '1px' }} className="my-4" />;
        },

        // Strong/Bold - gt-editor orange
        strong({ children }) {
          return (
            <strong style={{ color: colors.bold, fontWeight: 'bold' }}>
              {children}
            </strong>
          );
        },

        // Emphasis/Italic - gt-editor teal
        em({ children }) {
          return (
            <em style={{ color: colors.italic, fontStyle: 'italic' }}>
              {children}
            </em>
          );
        },

        // Strikethrough
        del({ children }) {
          return (
            <del style={{ color: colors.strike, textDecoration: 'line-through' }}>
              {children}
            </del>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default memo(MarkdownPreview);
