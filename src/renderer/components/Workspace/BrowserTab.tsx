import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { RotateCcw, ArrowLeft, ArrowRight, Globe, TerminalSquare } from 'lucide-react';
import Terminal from './Terminal';

interface BrowserTabProps {
  tabId: string;
  url: string;
  active: boolean;
  isActiveProject: boolean;
  terminalId?: string;
  terminalName?: string;
  activeView?: 'browser' | 'terminal';
  cwd: string;
}

function BrowserTab({ tabId, url, active, isActiveProject, terminalId, terminalName, activeView = 'terminal', cwd }: BrowserTabProps) {
  const webviewRef = useRef<any>(null);
  const [addressValue, setAddressValue] = useState(url || 'http://localhost:3000');
  const [isLoading, setIsLoading] = useState(false);
  const updateTabUrl = useWorkspaceStore((s) => s.updateTabUrl);
  const setBrowserActiveView = useWorkspaceStore((s) => s.setBrowserActiveView);

  // Sync address bar when url prop changes
  useEffect(() => {
    if (url) {
      setAddressValue(url);
    }
  }, [url]);

  // Webview event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleStartLoading = () => setIsLoading(true);
    const handleStopLoading = () => setIsLoading(false);
    const handleNavigate = (e: any) => {
      setAddressValue(e.url);
      updateTabUrl(tabId, e.url);
    };

    webview.addEventListener('did-start-loading', handleStartLoading);
    webview.addEventListener('did-stop-loading', handleStopLoading);
    webview.addEventListener('did-navigate', handleNavigate);
    webview.addEventListener('did-navigate-in-page', handleNavigate);

    return () => {
      webview.removeEventListener('did-start-loading', handleStartLoading);
      webview.removeEventListener('did-stop-loading', handleStopLoading);
      webview.removeEventListener('did-navigate', handleNavigate);
      webview.removeEventListener('did-navigate-in-page', handleNavigate);
    };
  }, [tabId, updateTabUrl]);

  const handleAddressSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    let navigateUrl = addressValue.trim();
    if (!navigateUrl) return;

    // Add http:// if no protocol
    if (!navigateUrl.match(/^https?:\/\//)) {
      navigateUrl = 'http://' + navigateUrl;
    }

    setAddressValue(navigateUrl);
    updateTabUrl(tabId, navigateUrl);

    const webview = webviewRef.current;
    if (webview) {
      webview.src = navigateUrl;
    }
  }, [addressValue, tabId, updateTabUrl]);

  const handleRefresh = useCallback(() => {
    const webview = webviewRef.current;
    if (webview) {
      webview.reload();
    }
  }, []);

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current;
    if (webview && webview.canGoBack()) {
      webview.goBack();
    }
  }, []);

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current;
    if (webview && webview.canGoForward()) {
      webview.goForward();
    }
  }, []);

  // Same pattern as Terminal.tsx: absolute positioning with visibility toggle
  const isVisible = active && isActiveProject;

  const isBrowserView = activeView === 'browser';
  const isTerminalView = activeView === 'terminal';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        visibility: isVisible ? 'visible' : 'hidden',
        pointerEvents: isVisible ? 'auto' : 'none',
        zIndex: isVisible ? 1 : 0,
      }}
    >
      {/* Toolbar - 30px */}
      <div
        style={{
          height: '30px',
          minHeight: '30px',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 8px',
          backgroundColor: '#1a1a1a',
          borderBottom: '1px solid #333',
        }}
      >
        {/* Nav buttons */}
        <button
          onClick={handleGoBack}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            padding: '2px',
            display: 'flex',
            alignItems: 'center',
          }}
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={handleGoForward}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            padding: '2px',
            display: 'flex',
            alignItems: 'center',
          }}
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          onClick={handleRefresh}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            padding: '2px',
            display: 'flex',
            alignItems: 'center',
          }}
          title="Refresh"
        >
          <RotateCcw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>

        {/* URL input */}
        <form onSubmit={handleAddressSubmit} style={{ flex: 1 }}>
          <input
            type="text"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            style={{
              width: '100%',
              height: '22px',
              backgroundColor: '#252525',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#ccc',
              fontSize: '12px',
              padding: '0 8px',
              outline: 'none',
            }}
            placeholder="http://localhost:3000"
          />
        </form>

        {/* Sub-tab switcher */}
        <div style={{ display: 'flex', gap: '2px', marginLeft: '4px' }}>
          <button
            onClick={() => setBrowserActiveView(tabId, 'browser')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '2px 8px',
              height: '22px',
              borderRadius: '4px',
              border: 'none',
              fontSize: '11px',
              cursor: 'pointer',
              backgroundColor: isBrowserView ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: isBrowserView ? '#fff' : '#888',
              transition: 'all 0.15s',
            }}
            title="Browser view"
          >
            <Globe size={12} />
            <span>Browser</span>
          </button>
          <button
            onClick={() => setBrowserActiveView(tabId, 'terminal')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '2px 8px',
              height: '22px',
              borderRadius: '4px',
              border: 'none',
              fontSize: '11px',
              cursor: 'pointer',
              backgroundColor: isTerminalView ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: isTerminalView ? '#fff' : '#888',
              transition: 'all 0.15s',
            }}
            title="Terminal view"
          >
            <TerminalSquare size={12} />
            <span>Term</span>
          </button>
        </div>
      </div>

      {/* Content area - both webview and terminal live in DOM, toggled by visibility */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Webview */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            visibility: isBrowserView ? 'visible' : 'hidden',
            pointerEvents: isBrowserView ? 'auto' : 'none',
            zIndex: isBrowserView ? 1 : 0,
          }}
        >
          <webview
            ref={webviewRef}
            src={url || 'http://localhost:3000'}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
            {...{ allowpopups: '' } as any}
          />
        </div>

        {/* Embedded Terminal */}
        {terminalId && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              visibility: isTerminalView ? 'visible' : 'hidden',
              pointerEvents: isTerminalView ? 'auto' : 'none',
              zIndex: isTerminalView ? 1 : 0,
            }}
          >
            <Terminal
              tabId={terminalId}
              cwd={cwd}
              active={active && isTerminalView}
              isActiveProject={isActiveProject}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(BrowserTab);
