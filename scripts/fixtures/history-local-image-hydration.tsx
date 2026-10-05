import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import HistoryPanel from "../../src/renderer/components/Workspace/HistoryPanel";
import { useWorkspaceStore } from "../../src/renderer/store/useWorkspaceStore";
import { useUIStore } from "../../src/renderer/store/useUIStore";
import {
  beginHistoryPromptHandoff,
  consumeHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot,
  hydrateHistoryPromptHandoffFromDurableReceipt,
} from "../../src/renderer/utils/historyPromptHandoffs";
import "../../packages/claude-blocks/src/theme.css";
import "../../packages/claude-blocks/src/blocks.css";

const { ipcRenderer } = window.require("electron");

type FixtureConfig = {
  projectId: string;
  cwd: string;
  tabId: string;
  sessionId: string;
  promptText: string;
  handoffId: string;
  operationKey: string;
  attemptId: string;
  initialHistory: any[];
  canonicalHistory: any[];
  receipt: any;
  eventHasImagePresentation: boolean;
};

const fixture: any = ((window as any).localImageHydrationFixture = {
  state: {
    events: [],
    hydrations: [],
    trusted: [],
    forbidden: [],
    errors: [],
    phase: "boot",
    mounted: true,
    canonical: false,
    listMode: false,
  },
});

for (const type of ["keydown", "click", "input"]) {
  document.addEventListener(
    type,
    (event) => {
      fixture.state.trusted.push({
        type,
        trusted: event.isTrusted,
        key: (event as KeyboardEvent).key || null,
        target:
          (event.target as HTMLElement)?.getAttribute?.("aria-label") ||
          (event.target as HTMLElement)?.tagName,
      });
    },
    true,
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(tabId: string) {
  const handoffs = getHistoryPromptHandoffsSnapshot(tabId);
  const root = document.querySelector("[data-local-image-hydration-fixture]");
  const rows = [
    ...(root?.querySelectorAll("[data-history-row-real]") || []),
  ].map((node) => ({
    uuid: node.getAttribute("data-uuid"),
    text: (node as HTMLElement).innerText?.slice(0, 120) || "",
  }));
  const tokens = [
    ...(root?.querySelectorAll('[data-history-composer-token="image"]') || []),
  ].map((node) => ({
    label: (node as HTMLElement).innerText?.trim() || "",
    path: node.getAttribute("data-path"),
  }));
  return {
    phase: fixture.state.phase,
    mounted: fixture.state.mounted,
    canonical: fixture.state.canonical,
    rows,
    rowCount: rows.length,
    imageTokenCount: tokens.length,
    imageTokens: tokens,
    imageRows: root?.querySelectorAll("[data-history-image-row]").length || 0,
    handoffs: handoffs.map((item) => ({
      handoffId: item.handoffId,
      queueStatus: item.queueStatus,
      imagePaths: item.imagePaths,
      attemptId: item.sendAttemptId,
      operationKey: item.sendOperationKey,
    })),
    previewStates: [
      ...(root?.querySelectorAll("[data-ai-composer-image-preview]") || []),
    ].map((node) => node.getAttribute("data-preview-state")),
    eventCount: fixture.state.events.length,
    hydrations: clone(fixture.state.hydrations),
  };
}

async function bootstrap() {
  const config: FixtureConfig = await ipcRenderer.invoke("fixture:config");
  const project = {
    projectId: config.projectId,
    projectPath: config.cwd,
    tabs: new Map([
      [
        config.tabId,
        {
          id: config.tabId,
          name: "captured local image hydration",
          cwd: config.cwd,
          commandType: "codex",
          tabType: "file",
          aiBusy: true,
          codexSessionId: config.sessionId,
        },
      ],
    ]),
    activeTabId: config.tabId,
    currentView: "terminal",
    selectedTabIds: [],
    tabGroups: [],
    tabHistory: [config.tabId],
    tabOrder: [config.tabId],
  };
  useWorkspaceStore.setState({
    activeProjectId: config.projectId,
    openProjects: new Map([[config.projectId, project]]),
  } as any);
  useUIStore.setState({
    terminalHistoryStreamingEnabled: true,
    historyFontSize: 14,
    promptSummaryGlobalAuto: false,
  } as any);
  useUIStore
    .getState()
    .setHistoryPromptDraft(config.tabId, "", { images: [], chips: [] });

  // This is the same app-level subscription used by the real renderer. The
  // receipt event is deliberately allowed to arrive before History remounts.
  ipcRenderer.on("agent:send-queue-receipt", (_event: any, record: any) => {
    fixture.state.events.push({
      type: "receipt",
      state: record?.state,
      hasImagePresentation: !!record?.imagePresentation,
    });
    const outcome = hydrateHistoryPromptHandoffFromDurableReceipt(record);
    fixture.state.hydrations.push({
      hydrated: outcome.hydrated,
      reason: outcome.reason,
      imageCount: outcome.handoff?.imagePaths?.length || 0,
    });
  });

  const startEmptyHandoff = () => {
    consumeHistoryPromptHandoff(config.tabId, config.handoffId);
    beginHistoryPromptHandoff({
      tabId: config.tabId,
      handoffId: config.handoffId,
      sendAttemptId: config.attemptId,
      sendOperationKey: config.operationKey,
      toolType: "codex",
      sessionIdHint: config.sessionId,
      text: config.promptText,
      imagePaths: [],
      promptChips: [],
      source: "history-panel",
      statusAtSend: "busy",
      initialStatus: "queued",
      requiresAuditIdentity: true,
    });
  };
  startEmptyHandoff();

  fixture.state.configReady = true;
  fixture.state.phase = "local-empty";
  fixture.config = config;
  fixture.snapshot = () => snapshot(config.tabId);
  fixture.emitReceipt = async (phase: "queued" | "confirmed") => {
    const result = await ipcRenderer.invoke("fixture:emit-receipt", { phase });
    ipcRenderer.emit("agent:send-queue-receipt", {}, result.record);
    fixture.state.phase = phase === "queued" ? "provider-queued" : "sent";
    return result;
  };
  fixture.materializeCanonical = async () => {
    const result = await ipcRenderer.invoke("fixture:materialize-canonical");
    await ipcRenderer.invoke("fixture:set-busy", false);
    useWorkspaceStore
      .getState()
      .setAiBusy(config.tabId, false, "turn-complete");
    const workspace = useWorkspaceStore
      .getState()
      .openProjects.get(config.projectId);
    if (workspace) {
      const tabs = new Map(workspace.tabs);
      const current = tabs.get(config.tabId);
      if (current) tabs.set(config.tabId, { ...current, aiBusy: false });
      const openProjects = new Map(useWorkspaceStore.getState().openProjects);
      openProjects.set(config.projectId, { ...workspace, tabs });
      useWorkspaceStore.setState({ openProjects } as any);
    }
    fixture.state.canonical = true;
    fixture.state.phase = "canonical";
    ipcRenderer.emit(
      "agent-transcript:changed",
      {},
      {
        tabId: config.tabId,
        toolType: "codex",
        sessionId: config.sessionId,
        fileIdentity: "private-captured-4944",
        reason: "fixture-canonical-alias-adoption",
      },
    );
    return result;
  };
  fixture.coldRemount = async () => {
    consumeHistoryPromptHandoff(config.tabId, config.handoffId);
    fixture.state.listMode = false;
    fixture.state.canonical = false;
    await ipcRenderer.invoke("fixture:set-canonical", false);
    // The app-level receipt listener receives the exact proof while History is
    // unmounted. Mounting later must replay that already-hydrated handoff.
    const receiptResult = await ipcRenderer.invoke("fixture:emit-receipt", {
      phase: "confirmed",
    });
    ipcRenderer.emit("agent:send-queue-receipt", {}, receiptResult.record);
    const coldOutcome = hydrateHistoryPromptHandoffFromDurableReceipt(
      receiptResult.record,
    );
    fixture.state.hydrations.push({
      phase: "cold-remount",
      hydrated: coldOutcome.hydrated,
      reason: coldOutcome.reason,
      imageCount: coldOutcome.handoff?.imagePaths?.length || 0,
    });
    fixture.setMounted(false);
    await new Promise((resolve) => setTimeout(resolve, 90));
    fixture.setMounted(true);
    fixture.state.phase = "cold-remount";
  };
  fixture.resetLocal = () => {
    fixture.state.listMode = false;
    fixture.state.canonical = false;
    fixture.state.phase = "local-empty";
    startEmptyHandoff();
  };
  fixture.emitForeign = async () => {
    fixture.state.phase = "foreign-proof";
    const result = await ipcRenderer.invoke("fixture:emit-foreign");
    ipcRenderer.emit("agent:send-queue-receipt", {}, result.record);
    return result;
  };
  fixture.setMounted = (value: boolean) => {
    fixture.state.mounted = value;
  };

  function Fixture() {
    const [, setRevision] = useState(0);
    const [mounted, setMounted] = useState(true);
    fixture.setMounted = (value: boolean) => {
      setMounted(value);
      fixture.state.mounted = value;
      setRevision((v) => v + 1);
    };
    useEffect(() => {
      const timer = window.setInterval(() => setRevision((v) => v + 1), 80);
      return () => window.clearInterval(timer);
    }, []);
    return (
      <div
        data-local-image-hydration-fixture
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#1a1a1a",
        }}
      >
        <header
          style={{
            height: 42,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 12px",
            flexShrink: 0,
          }}
        >
          <strong>Private captured local image hydration</strong>
          <button
            data-fixture-emit-queued
            onClick={() => void fixture.emitReceipt("queued")}
          >
            Provider queued
          </button>
          <button
            data-fixture-emit-sent
            onClick={() => void fixture.emitReceipt("confirmed")}
          >
            SENT
          </button>
          <button
            data-fixture-canonical
            onClick={() => void fixture.materializeCanonical()}
          >
            Canonical late alias
          </button>
          <button
            data-fixture-cold-remount
            onClick={() => void fixture.coldRemount()}
          >
            Cold remount
          </button>
          <button
            data-fixture-foreign
            onClick={() => void fixture.emitForeign()}
          >
            Foreign proof
          </button>
          <button
            data-fixture-toggle
            onClick={() => fixture.setMounted(!mounted)}
          >
            {mounted ? "Hide History" : "Show History"}
          </button>
        </header>
        <div style={{ position: "relative", minHeight: 0, flex: 1 }}>
          {mounted && (
            <HistoryPanel
              key={fixture.state.listMode ? "cold-list" : "live"}
              tabId={config.tabId}
              projectId={config.projectId}
              sessionId={config.sessionId}
              cwd={config.cwd}
              width={1100}
              notesPanelWidth={0}
              isOpen
              embedded
              embeddedFill
              mainSurface
              enableClaudePtyControls
              toolType="codex"
              presented
              preservePresentationGeometry
            />
          )}
        </div>
      </div>
    );
  }

  createRoot(document.getElementById("root")!).render(<Fixture />);
}

bootstrap().catch((error) => {
  fixture.state.errors.push(String(error?.stack || error));
});
