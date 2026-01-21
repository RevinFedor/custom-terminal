import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
  content: string;
}

function MarkdownRenderer({ content }: MarkdownRendererProps) {
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
              <div className="my-2 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-[#1e1e1e] text-[10px] text-gray-500">
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
                    fontSize: '12px',
                    lineHeight: 1.5,
                    background: '#282c34'
                  }}
                  {...props}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            );
          }

          // Inline code or code without language
          if (!inline) {
            return (
              <pre className="my-2 p-3 bg-[#1e1e1e] rounded-lg overflow-x-auto text-xs">
                <code className="text-gray-300" {...props}>
                  {children}
                </code>
              </pre>
            );
          }

          // Inline code
          return (
            <code className="px-1.5 py-0.5 bg-[#333] rounded text-[12px] text-pink-400" {...props}>
              {children}
            </code>
          );
        },

        // Paragraphs - avoid nesting block elements
        p({ children, node }) {
          // Check if children contain block-level elements (pre, div, etc.)
          const hasBlockChild = node?.children?.some((child: any) =>
            child.tagName === 'pre' || child.tagName === 'div'
          );
          // If has block children, render as div instead of p
          if (hasBlockChild) {
            return <div className="mb-3 last:mb-0">{children}</div>;
          }
          return <p className="mb-3 last:mb-0">{children}</p>;
        },

        // Headers
        h1({ children }) {
          return <h1 className="text-lg font-bold mb-3 mt-4 first:mt-0">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="text-sm font-bold mb-2 mt-3 first:mt-0">{children}</h3>;
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

        // Links
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline"
            >
              {children}
            </a>
          );
        },

        // Blockquotes
        blockquote({ children }) {
          return (
            <blockquote className="border-l-2 border-gray-500 pl-3 my-2 text-gray-400 italic">
              {children}
            </blockquote>
          );
        },

        // Tables
        table({ children }) {
          return (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse text-xs">{children}</table>
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
          return <hr className="my-4 border-[#444]" />;
        },

        // Strong/Bold
        strong({ children }) {
          return <strong className="font-semibold text-white">{children}</strong>;
        },

        // Emphasis/Italic
        em({ children }) {
          return <em className="italic text-gray-300">{children}</em>;
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default memo(MarkdownRenderer);
