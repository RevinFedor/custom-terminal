import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { RotateCcw, ArrowLeft, ArrowRight, Globe, TerminalSquare, AlertTriangle } from 'lucide-react';
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

function BrowserTab({ tabId, url, active, isActiveProject, terminalId, terminalName, activeView = 'browser', cwd }: BrowserTabProps) {
  const webviewRef = useRef<any>(null);
  const initialUrl = url || 'http://localhost:3000';
  const [addressValue, setAddressValue] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const updateTabUrl = useWorkspaceStore((s) => s.updateTabUrl);
  const setBrowserActiveView = useWorkspaceStore((s) => s.setBrowserActiveView);

  // Sync address bar when url prop changes (ignore about:blank)
  useEffect(() => {
    if (url && url !== 'about:blank') {
      setAddressValue(url);
    }
  }, [url]);

  // Webview event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDomReady = () => setIsReady(true);
    const handleStartLoading = () => {
      setIsLoading(true);
      setLoadError(null);
    };
    const handleStopLoading = () => setIsLoading(false);
    const handleNavigate = (e: any) => {
      // Skip about:blank — don't overwrite real URL in store
      if (e.url === 'about:blank') return;
      setAddressValue(e.url);
      updateTabUrl(tabId, e.url);
    };
    const handleFailLoad = (e: any) => {
      // -3 = ERR_ABORTED (user navigated away / view switched) — benign
      // 0 = no error
      if (e.errorCode === -3 || e.errorCode === 0) return;
      setLoadError(`${e.errorDescription || 'Connection failed'} (${e.validatedURL})`);
      setIsLoading(false);
    };

    webview.addEventListener('dom-ready', handleDomReady);
    webview.addEventListener('did-start-loading', handleStartLoading);
    webview.addEventListener('did-stop-loading', handleStopLoading);
    webview.addEventListener('did-navigate', handleNavigate);
    webview.addEventListener('did-navigate-in-page', handleNavigate);
    webview.addEventListener('did-fail-load', handleFailLoad);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('did-start-loading', handleStartLoading);
      webview.removeEventListener('did-stop-loading', handleStopLoading);
      webview.removeEventListener('did-navigate', handleNavigate);
      webview.removeEventListener('did-navigate-in-page', handleNavigate);
      webview.removeEventListener('did-fail-load', handleFailLoad);
    };
  }, [tabId, updateTabUrl]);

  const handleAddressSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    let navigateUrl = addressValue.trim();
    if (!navigateUrl) return;

    if (!navigateUrl.match(/^https?:\/\//)) {
      navigateUrl = 'http://' + navigateUrl;
    }

    setAddressValue(navigateUrl);
    updateTabUrl(tabId, navigateUrl);
    setLoadError(null);

    const webview = webviewRef.current;
    if (webview && isReady) {
      webview.src = navigateUrl;
    }
  }, [addressValue, tabId, updateTabUrl, isReady]);

  const handleRefresh = useCallback(() => {
    const webview = webviewRef.current;
    if (webview && isReady) {
      setLoadError(null);
      webview.reload();
    }
  }, [isReady]);

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current;
    if (webview && isReady && webview.canGoBack()) {
      webview.goBack();
    }
  }, [isReady]);

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current;
    if (webview && isReady && webview.canGoForward()) {
      webview.goForward();
    }
  }, [isReady]);

  const isVisible = active && isActiveProject;
  const isBrowserView = activeView === 'browser';
  const isTerminalView = activeView === 'terminal';

  // Blur webview when switching to terminal view — webview is a separate WebContents
  // that holds Chromium-level keyboard focus even with visibility:hidden.
  // useEffect runs after paint — serves as fallback for persisted state restoration.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (isTerminalView && isVisible) {
      webview.blur();
    }
  }, [isTerminalView, isVisible]);

  // Synchronous view switch handlers — blur/focus webview BEFORE React re-render
  // to prevent Chromium input routing race (useEffect alone is too late)
  const handleSwitchToTerminal = useCallback(() => {
    webviewRef.current?.blur();
    setBrowserActiveView(tabId, 'terminal');
  }, [tabId, setBrowserActiveView]);

  const handleSwitchToBrowser = useCallback(() => {
    setBrowserActiveView(tabId, 'browser');
  }, [tabId, setBrowserActiveView]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        visibility: isVisible ? 'inherit' : 'hidden',
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
        <button
          onClick={handleGoBack}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={handleGoForward}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          onClick={handleRefresh}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
          title="Refresh"
        >
          <RotateCcw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>

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
              border: `1px solid ${loadError ? '#ef4444' : '#444'}`,
              borderRadius: '4px',
              color: '#ccc',
              fontSize: '12px',
              padding: '0 8px',
              outline: 'none',
            }}
            placeholder="http://localhost:3000"
          />
        </form>

        <div style={{ display: 'flex', gap: '2px', marginLeft: '4px' }}>
          <button
            onClick={handleSwitchToBrowser}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 8px', height: '22px',
              borderRadius: '4px', border: 'none', fontSize: '11px', cursor: 'pointer',
              backgroundColor: isBrowserView ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: isBrowserView ? '#fff' : '#888', transition: 'all 0.15s',
            }}
            title="Browser view"
          >
            <Globe size={12} />
            <span>Browser</span>
          </button>
          <button
            onClick={handleSwitchToTerminal}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 8px', height: '22px',
              borderRadius: '4px', border: 'none', fontSize: '11px', cursor: 'pointer',
              backgroundColor: isTerminalView ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: isTerminalView ? '#fff' : '#888', transition: 'all 0.15s',
            }}
            title="Terminal view"
          >
            <TerminalSquare size={12} />
            <span>Term</span>
          </button>
        </div>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Webview — src set directly, errors handled via did-fail-load */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            visibility: isBrowserView ? 'inherit' : 'hidden',
            pointerEvents: isBrowserView ? 'auto' : 'none',
            zIndex: isBrowserView ? 1 : 0,
          }}
        >
          <webview
            ref={webviewRef}
            src={initialUrl}
            style={{ width: '100%', height: '100%', border: 'none' }}
            {...{ allowpopups: '' } as any}
          />

          {/* Error overlay */}
          {loadError && isBrowserView && (
            <div
              style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a1a', gap: '12px',
              }}
            >
              <AlertTriangle size={32} color="#ef4444" />
              <div style={{ color: '#888', fontSize: '13px', textAlign: 'center', maxWidth: '400px', padding: '0 20px' }}>
                {loadError}
              </div>
              <button
                onClick={handleRefresh}
                style={{
                  padding: '6px 16px', backgroundColor: '#333', border: '1px solid #555',
                  borderRadius: '6px', color: '#ccc', fontSize: '12px', cursor: 'pointer',
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Embedded Terminal */}
        {terminalId && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              visibility: isTerminalView ? 'inherit' : 'hidden',
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
