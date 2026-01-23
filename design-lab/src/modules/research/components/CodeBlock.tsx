import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Check, Copy } from 'lucide-react';

interface CodeBlockProps {
  language: string;
  value: string;
}

export default function CodeBlock({ language, value }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-4 rounded-xl overflow-hidden border border-[#333] bg-[#0c0c0c] shadow-sm group/code">
      <div className="flex items-center justify-between px-4 py-2 bg-[#1e1f20] border-b border-[#333]">
        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
          {language || 'text'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-[10px] font-bold text-gray-500 hover:text-white transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check size={12} className="text-green-400" />
              <span className="text-green-400 uppercase tracking-wider">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span className="uppercase tracking-wider">Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="relative group">
        <SyntaxHighlighter
          language={language || 'text'}
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: '20px',
            fontSize: '13px',
            lineHeight: '1.6',
            backgroundColor: '#0c0c0c',
          }}
          wrapLongLines={true}
        >
          {value}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
