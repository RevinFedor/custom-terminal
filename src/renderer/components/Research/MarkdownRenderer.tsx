import React, { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import CollapsiblePastedBlock from './CollapsiblePastedBlock';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// Segment type for pre-processing pasted blocks
type Segment = { type: 'markdown' | 'pasted'; content: string };

function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  // Pre-process content: extract :::pasted blocks BEFORE markdown parsing
  // This avoids conflicts with ``` inside pasted content
  const segments = useMemo<Segment[]>(() => {
    const pastedRegex = /:::pasted\n([\s\S]*?)\n:::/g;
    const result: Segment[] = [];
    let lastIndex = 0;
    let match;

    while ((match = pastedRegex.exec(content)) !== null) {
      // Add markdown text before this match
      if (match.index > lastIndex) {
        result.push({ type: 'markdown', content: content.slice(lastIndex, match.index) });
      }
      // Add pasted block
      result.push({ type: 'pasted', content: match[1] });
      lastIndex = match.index + match[0].length;
    }

    // Add remaining markdown text
    if (lastIndex < content.length) {
      result.push({ type: 'markdown', content: content.slice(lastIndex) });
    }

    // If no pasted blocks found, return single markdown segment
    if (result.length === 0) {
      return [{ type: 'markdown', content }];
    }

    return result;
  }, [content]);

  // Markdown components configuration
  const markdownComponents = {
    // Pre element wraps code blocks - handle all block code here
    pre({ children, ...props }: any) {
      // Extract code element from pre children
      const codeElement = React.Children.toArray(children)[0] as React.ReactElement;

      if (React.isValidElement(codeElement) && codeElement.type === 'code') {
        const { className, children: codeChildren } = codeElement.props;
        const match = /language-(\w+)/.exec(className || '');
        const language = match ? match[1] : '';
        const value = String(codeChildren).replace(/\n$/, '');

        // Code block with language - use syntax highlighter
        if (language) {
          return <CodeBlock language={language} value={value} />;
        }

        // Code block without language
        return (
          <pre className="my-3 p-3 rounded-lg bg-[#1a1a1a] border border-[#333] overflow-x-auto text-xs text-gray-300">
            <code>{codeChildren}</code>
          </pre>
        );
      }

      // Fallback
      return <pre {...props}>{children}</pre>;
    },

          // Code element - now only called for INLINE code (not inside pre)
          code({ className, children, ...props }: any) {
            // Inline code - simple styling
            return (
              <code className="px-1.5 py-0.5 bg-[#333] rounded text-[12px] text-[#a8c7fa] font-mono" {...props}>
                {children}
              </code>
            );
          },

          // Paragraphs
          p({ children }) {
            return <div className="mb-4 last:mb-0 text-gray-300">{children}</div>;
          },

          // Headers
          h1({ children }) {
            return <h1 className="text-xl font-bold mb-4 mt-6 first:mt-0 text-white pb-2 border-b border-[#333]">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-lg font-bold mb-3 mt-5 first:mt-0 text-white">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-base font-semibold mb-2 mt-4 first:mt-0 text-white">{children}</h3>;
          },
          h4({ children }) {
            return <h4 className="text-sm font-semibold mb-2 mt-4 first:mt-0 text-white">{children}</h4>;
          },

          // Lists
          ul({ children }) {
            return <ul className="list-disc list-outside ml-4 mb-4 space-y-1 marker:text-[#666]">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal list-outside ml-4 mb-4 space-y-1 marker:text-[#666]">{children}</ol>;
          },
          li({ children }) {
            return <li className="pl-1">{children}</li>;
          },

          // Links
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
              >
                {children}
              </a>
            );
          },

          // Blockquotes
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-[#444] pl-4 py-1 my-4 bg-[#252525]/50 rounded-r text-gray-400 italic">
                {children}
              </blockquote>
            );
          },

          // Tables
          table({ children }) {
            return (
              <div className="overflow-x-auto my-4 border border-[#333] rounded-lg">
                <table className="min-w-full text-left text-xs">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-[#252525] text-gray-300 font-medium">{children}</thead>;
          },
          tbody({ children }) {
            return <tbody className="divide-y divide-[#333]">{children}</tbody>;
          },
          tr({ children }) {
            return <tr className="hover:bg-[#2a2a2a] transition-colors">{children}</tr>;
          },
          th({ children }) {
            return <th className="px-4 py-3 font-semibold">{children}</th>;
          },
          td({ children }) {
            return <td className="px-4 py-2.5 text-gray-400">{children}</td>;
          },

          // Horizontal rule
          hr() {
            return <hr className="my-6 border-[#333]" />;
          },

          // Strong/Bold
          strong({ children }) {
            return <strong className="font-semibold text-white">{children}</strong>;
          },

    // Emphasis/Italic
    em({ children }) {
      return <em className="italic text-gray-300">{children}</em>;
    }
  };

  return (
    <div className={`text-[13px] leading-relaxed text-gray-200 ${className}`}>
      {segments.map((segment, index) => {
        if (segment.type === 'pasted') {
          return <CollapsiblePastedBlock key={index} content={segment.content} />;
        }
        return (
          <ReactMarkdown
            key={index}
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {segment.content}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}

export default memo(MarkdownRenderer);