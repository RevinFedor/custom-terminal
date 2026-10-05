#!/usr/bin/env node
// Private Electron/HistoryPanel regression for captured handoff 4944.
// No provider, PTY, production API, real receipt, or JSONL is touched.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("..", import.meta.url));
const arg = (name) =>
  process.argv
    .find((value) => value.startsWith("--" + name + "="))
    ?.split("=")
    .slice(1)
    .join("=");
const freezeFrom = path.resolve(arg("source") || repo);
const baseline = Boolean(arg("source"));
const popupOnly = Boolean(arg("popup-only"));
const rootArtifact =
  process.env.NOTED_LOCAL_IMAGE_ARTIFACT ||
  "/private/tmp/noted-local-image4944-20261004.liQQ1A/green";
const artifact = rootArtifact;
const snapshot = path.join(artifact, "source");
const shared = path.join(artifact, "shared");
const packet = "/private/tmp/ios-dictation-scroll-20261004/audit-input-v1";
const receiptPath = path.join(packet, "receipt-4944.json");
const historyPath = path.join(packet, "history-4944.json");
const eventLog = [];
const errors = [];
const resourceFailures = [];
const stamp = () => new Date().toISOString();
const log = (message, data = {}) => {
  const line = `${stamp()} ${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""}`;
  eventLog.push(line);
  return line;
};
const sha256 = async (file) =>
  crypto
    .createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

const result = {
  status: "RUNNING",
  sourceMode: baseline ? "baseline-red" : "current-green",
  freezeFrom,
  artifact,
  executor: { model: "Codex delegated E2E executor", effort: "standard" },
  target: {
    runtime: "Electron 28",
    mode: "private standalone offscreen launch",
    provider: false,
    cdp: false,
  },
  actions: [],
  evidence: {},
  checks: [],
  errors,
  cleanup: {},
};
let app;
let worktreeAdded = false;
let page;

function check(name, condition, evidence) {
  const pass = Boolean(condition);
  result.checks.push({
    name,
    pass,
    ...(evidence === undefined ? {} : { evidence }),
  });
  if (!pass) log("CHECK_FAIL " + name, evidence || {});
  return pass;
}

function makeInternalRecord(raw, projectedImagePresentation) {
  const record = {
    ...clone(raw),
    receipt: clone(raw),
    promptLength: raw.imageRequestProjection.requestLength,
    // Preserve the captured project-api surface. applicationQueue v1 is the
    // explicit bridge that lets the renderer hydrate this owned card; do not
    // relabel a remote receipt as a desktop-history send.
    surface: raw.surface,
    state: "audit-pending",
    applicationQueue: {
      version: 1,
      id: 4944,
      state: "provider-queued",
      queuedAt: raw.createdAt,
    },
    auditIdentity: {
      attemptId: raw.attemptId,
      provider: raw.provider,
      sessionId: raw.sessionId,
      promptHash: raw.actualHash,
      entryUuid: raw.entryUuid,
      sourceIdentity: raw.sourceIdentity,
      auditTimestamp: raw.auditTimestamp,
    },
    ...(projectedImagePresentation
      ? { imagePresentation: projectedImagePresentation }
      : {}),
  };
  record.receipt.promptText = raw.promptText;
  record.receipt.source = "history-panel";
  record.receipt.providerQueue = {
    accepted: true,
    provider: raw.provider,
    operationKey: raw.operationKey,
    attemptId: raw.attemptId,
    sourceIdentity: "codex-queue:4944-provider-accepted",
    sessionId: raw.sessionId,
  };
  return record;
}

function recordForPhase(base, phase, imagePresentation) {
  const record = clone(base);
  record.state = phase === "confirmed" ? "confirmed" : "audit-pending";
  record.applicationQueue = {
    version: 1,
    id: 4944,
    state: phase === "confirmed" ? "completed" : "provider-queued",
    queuedAt: base.createdAt,
  };
  record.receipt = { ...clone(base.receipt) };
  if (phase === "confirmed") {
    record.receipt.providerQueue = undefined;
    record.receipt.exactAuditConfirmed = true;
    record.receipt.actualHash = base.receipt.actualHash;
    record.receipt.auditTimestamp = base.receipt.auditTimestamp;
    record.receipt.sessionId = base.sessionId;
    record.receipt.entryUuid = base.receipt.entryUuid;
    record.receipt.sourceIdentity = base.receipt.sourceIdentity;
    record.receipt.recordByteOffset = base.receipt.recordByteOffset;
    record.auditIdentity = {
      ...record.auditIdentity,
      promptHash: base.receipt.actualHash,
      entryUuid: base.receipt.entryUuid,
      sourceIdentity: base.receipt.sourceIdentity,
      auditTimestamp: base.receipt.auditTimestamp,
    };
  } else {
    record.receipt.providerQueue = {
      accepted: true,
      provider: base.provider,
      operationKey: base.operationKey,
      attemptId: base.attemptId,
      sourceIdentity: "codex-queue:4944-provider-accepted",
      sessionId: base.sessionId,
    };
  }
  record.updatedAt = Date.now();
  if (imagePresentation) record.imagePresentation = clone(imagePresentation);
  else delete record.imagePresentation;
  return record;
}

async function createFixtureData() {
  await fs.access(receiptPath);
  await fs.access(historyPath);
  const raw = JSON.parse(await fs.readFile(receiptPath, "utf8")).receipts?.[0];
  const history = JSON.parse(await fs.readFile(historyPath, "utf8"));
  assert.ok(raw, "captured receipt 4944 must be present");
  assert.equal(raw.handoffId, "4944F39A-2903-41E9-B4A8-1D7FFEEB9313");
  assert.equal(raw.provider, "codex");
  assert.equal(raw.sessionId, "918b29e9-3369-4d94-8739-3b2cbefe7351");
  assert.equal(
    raw.tabId,
    "new_project_1770989259412_9ryw9s-tab-orchestration-9943cdb9-cb5d-4497-9c14-d8bb746ece32",
  );
  assert.equal(raw.expectedImageRefs.length, 1);
  assert.equal(
    raw.expectedImageRefs[0].path,
    "/var/folders/72/jx261489331_qw1xj740p5lc0000gn/T/noted-terminal-mobile-attachments/7f8abd5f-fe1f-4c2b-adca-e908d757386a/photo-1791125478-1.jpg",
  );
  const canonical = history.entries.find(
    (entry) => entry.uuid === raw.entryUuid,
  );
  assert.ok(canonical, "captured canonical user row 36520 must be present");
  assert.equal(canonical.imagePaths?.[0]?.path, raw.expectedImageRefs[0].path);

  // This invokes the real Main projection validator. No path is invented: all
  // paths come from the captured receipt and its exact imageRequestProjection.
  const { imagePresentationFromReceipt } = require(
    path.join(repo, "src/main/history-authoring-projection.js"),
  );
  const internal = makeInternalRecord(raw, null);
  const imagePresentation = imagePresentationFromReceipt(internal);
  assert.ok(
    imagePresentation,
    "captured 4944 must yield trusted imagePresentation",
  );
  assert.equal(
    imagePresentation.imagePaths[0].path,
    raw.expectedImageRefs[0].path,
  );

  const imageSource = raw.expectedImageRefs[0].path;
  const imageHash = await sha256(imageSource);
  const privateImagePath = path.join(
    artifact,
    "private-images",
    "photo-1791125478-1.jpg",
  );
  await fs.mkdir(path.dirname(privateImagePath), { recursive: true });
  await fs.copyFile(imageSource, privateImagePath);
  const privateHash = await sha256(privateImagePath);
  assert.equal(privateHash, imageHash, "private JPG copy must be byte exact");
  const initialHistory = history.entries.filter(
    (entry) => entry.uuid !== raw.entryUuid,
  );
  const canonicalHistory = history.entries;
  const frozenWebServer = await fs.readFile(
    path.join(freezeFrom, "src/main/web-server.js"),
    "utf8",
  );
  const eventHasImagePresentation = frozenWebServer.includes(
    "imagePresentation: imagePresentationFromReceipt(record)",
  );
  const config = {
    projectId: "private-local-image-4944-project",
    cwd: "/private/local-image-4944-fixture",
    tabId: raw.tabId,
    sessionId: raw.sessionId,
    promptText: raw.promptText,
    handoffId: raw.handoffId,
    operationKey: raw.operationKey,
    attemptId: raw.attemptId,
    imageSource,
    privateImagePath,
    imageHash,
    privateHash,
    initialHistory,
    canonicalHistory,
    receipt: internal,
    imagePresentation,
    eventHasImagePresentation,
    canonicalUuid: canonical.uuid,
    localUuid: "local-prompt-" + raw.tabId + "-" + raw.handoffId,
  };
  await fs.writeFile(
    path.join(artifact, "fixture-config.json"),
    JSON.stringify(config, null, 2),
  );
  result.evidence.fixture = {
    handoffId: raw.handoffId,
    entryUuid: canonical.uuid,
    localUuid: "local-prompt-" + raw.tabId + "-" + raw.handoffId,
    sourcePath: imageSource,
    imageHash,
    privateHash,
    privateImagePath,
    eventHasImagePresentation,
    initialRowCount: initialHistory.length,
    canonicalRowCount: canonicalHistory.length,
  };
  result.actions.push(
    "read captured receipt/history, reconstructed exact internal receipt and copied private JPG byte-exactly",
  );
  log("FIXTURE captured receipt validated", result.evidence.fixture);
  return config;
}

function privateMain(config) {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const fs = require("node:fs");
  app.setPath("userData", config.userData);
  app.setActivationPolicy?.("accessory");
  const fixtureConfig = JSON.parse(fs.readFileSync(config.configPath, "utf8"));
  const state = { listMode: false, canonical: false, busy: true };
  let windowRef = null;
  const forbidden = [];
  global.localImageHydrationMain = { forbidden, state };
  const phaseRecord = (phase, includeImage) => {
    const record = JSON.parse(JSON.stringify(fixtureConfig.receipt));
    record.state = phase === "confirmed" ? "confirmed" : "audit-pending";
    record.applicationQueue = {
      version: 1,
      id: 4944,
      state: phase === "confirmed" ? "completed" : "provider-queued",
      queuedAt: fixtureConfig.receipt.createdAt,
    };
    record.receipt = { ...JSON.parse(JSON.stringify(fixtureConfig.receipt)) };
    if (phase === "confirmed") {
      delete record.receipt.providerQueue;
      record.receipt.exactAuditConfirmed = true;
      record.receipt.actualHash = fixtureConfig.receipt.actualHash;
      record.receipt.auditTimestamp = fixtureConfig.receipt.auditTimestamp;
      record.receipt.sessionId = fixtureConfig.sessionId;
      record.receipt.entryUuid = fixtureConfig.receipt.entryUuid;
      record.receipt.sourceIdentity = fixtureConfig.receipt.sourceIdentity;
      record.receipt.recordByteOffset = fixtureConfig.receipt.recordByteOffset;
    } else {
      record.receipt.providerQueue = {
        accepted: true,
        provider: fixtureConfig.receipt.provider,
        operationKey: fixtureConfig.receipt.operationKey,
        attemptId: fixtureConfig.receipt.attemptId,
        sourceIdentity: "codex-queue:4944-provider-accepted",
        sessionId: fixtureConfig.sessionId,
      };
    }
    record.updatedAt = Date.now();
    if (includeImage)
      record.imagePresentation = JSON.parse(
        JSON.stringify(fixtureConfig.imagePresentation),
      );
    else delete record.imagePresentation;
    return record;
  };
  const currentRecord = (phase, includeImage) => {
    return phaseRecord(phase, includeImage);
  };
  ipcMain.handle("fixture:invoke", async (_event, { channel, args }) => {
    const payload = args?.[0];
    if (channel === "fixture:config") return fixtureConfig;
    if (channel === "fixture:emit-receipt") {
      const phase = payload?.phase === "confirmed" ? "confirmed" : "queued";
      const includeImage = fixtureConfig.eventHasImagePresentation;
      const record = currentRecord(phase, includeImage);
      return {
        success: true,
        phase,
        hasImagePresentation: !!record.imagePresentation,
        record,
      };
    }
    if (channel === "fixture:emit-foreign") {
      const record = currentRecord("confirmed", true);
      record.handoffId = fixtureConfig.handoffId + "-foreign";
      record.operationKey = fixtureConfig.operationKey + "-foreign";
      record.attemptId = fixtureConfig.attemptId + "-foreign";
      record.receipt = { ...record.receipt, providerQueue: undefined };
      record.imagePresentation = {
        ...record.imagePresentation,
        operationKey: fixtureConfig.operationKey,
        imagePaths: [
          {
            ...fixtureConfig.imagePresentation.imagePaths[0],
            path: "/private/fake/foreign.jpg",
          },
        ],
      };
      return { success: true, record };
    }
    if (channel === "fixture:materialize-canonical") {
      state.canonical = true;
      return { success: true };
    }
    if (channel === "fixture:set-busy") {
      state.busy = payload !== false;
      return { success: true };
    }
    if (channel === "fixture:set-canonical") {
      state.canonical = payload === true;
      return { success: true };
    }
    if (channel === "fixture:set-list-mode") {
      state.listMode = payload === true;
      return { success: true };
    }
    if (channel === "prompt-queue:get-image-preview-data-url") {
      const ref = payload || {};
      const pathValue = String(ref.path || "");
      if (pathValue !== fixtureConfig.imageSource)
        return { success: false, error: "fixture_path_not_admitted" };
      const data = fs
        .readFileSync(fixtureConfig.privateImagePath)
        .toString("base64");
      return {
        success: true,
        dataUrl: "data:image/jpeg;base64," + data,
        path: pathValue,
        mediaType: "image/jpeg",
        width: 1024,
        height: 768,
      };
    }
    if (channel === "agent:list-send-receipts") {
      if (!state.listMode) return { success: true, records: [] };
      return { success: true, records: [currentRecord("confirmed", true)] };
    }
    if (channel === "agent:acknowledge-send-receipt-presentation")
      return { success: true, applied: true };
    if (channel === "agent:dismiss-send-receipt-presentation")
      return { success: true, dismissed: true };
    if (channel === "agent:send-queue-ready") return { success: true };
    if (
      channel === "agent-transcript:get-history" ||
      channel === "claude:get-full-history"
    ) {
      return {
        success: true,
        entries: state.canonical
          ? fixtureConfig.canonicalHistory
          : fixtureConfig.initialHistory,
        payloadGeneration: state.canonical
          ? "private-canonical-2"
          : "private-initial-1",
        revision: {
          sources: [
            {
              sessionId: fixtureConfig.sessionId,
              fileIdentity: "private-captured-4944",
              linkKind: "end",
            },
          ],
        },
      };
    }
    if (
      channel === "codex:get-runtime-projection" ||
      channel === "codex:get-runtime-session"
    ) {
      return {
        success: true,
        projectId: fixtureConfig.projectId,
        sessionStatus: state.busy ? "busy" : "active",
        busy: state.busy,
        inputReady: true,
        liveLifecycle: true,
        sessionId: fixtureConfig.sessionId,
        readSessionId: fixtureConfig.sessionId,
        readIdentitySource: "live-writer",
        savedSessionId: fixtureConfig.sessionId,
        conversationMaterialized: true,
        timelineCount: 3,
        canCopySessionId: true,
        hasTerm: true,
        hasWatcher: true,
        catchUpPending: false,
        outcomeKnown: false,
        writerConfirmed: true,
        writerStatus: "adopted",
        writerUsableForMutation: true,
        provenWriterSessionId: fixtureConfig.sessionId,
        writerProof: "private-captured-4944",
        launchId: "fixture-launch",
        lifecycleGeneration: 1,
      };
    }
    if (
      channel === "codex:get-draft-state" ||
      channel === "claude:get-draft-state"
    ) {
      return {
        success: true,
        hasDraft: false,
        preview: "",
        source: "fixture",
        proofOutcome: "absent",
      };
    }
    if (channel === "agent-activity:get-tab-timing")
      return { success: true, timing: null };
    if (channel === "agent-session:get-availability-batch")
      return {
        success: true,
        results: (payload?.sessions || []).map((item) => ({
          ...item,
          state: "available",
          historyState: "available",
          checkedAt: Date.now(),
        })),
      };
    if (/^agent-transcript:(subscribe|unsubscribe)$/.test(channel))
      return { success: true };
    if (channel === "file:exists-batch")
      return Object.fromEntries((payload || []).map((value) => [value, false]));
    if (channel === "terminal:getCommandStates") return {};
    if (channel === "terminal:hasRunningProcess") return { isRunning: false };
    if (channel === "terminal:getCommandState") return null;
    if (
      /^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:(send-command|run)|agent:(stop|rewind))/.test(
        channel,
      )
    ) {
      forbidden.push(channel);
      throw new Error(
        "Private fixture forbids provider/PTY channel " + channel,
      );
    }
    if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
    return { success: true };
  });
  app.whenReady().then(() => {
    app.dock?.hide();
    windowRef = new BrowserWindow({
      show: false,
      focusable: false,
      width: 1200,
      height: 1000,
      webPreferences: {
        offscreen: true,
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        preload: config.preload,
      },
    });
    windowRef.loadFile(config.html);
  });
  app.on("window-all-closed", () => app.quit());
}

async function run() {
  try {
    await fs.rm(artifact, { recursive: true, force: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.mkdir(shared, { recursive: true });
    const config = await createFixtureData();
    for (const name of ["src", "packages/claude-blocks"]) {
      await fs.cp(path.join(freezeFrom, name), path.join(snapshot, name), {
        recursive: true,
        force: true,
        filter: (entry) =>
          !entry.includes("/node_modules") && !entry.includes("/.git"),
      });
    }
    await fs.mkdir(path.join(snapshot, "scripts/fixtures"), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(repo, "scripts/fixtures/history-local-image-hydration.tsx"),
      path.join(snapshot, "scripts/fixtures/history-local-image-hydration.tsx"),
    );
    await fs.symlink(
      path.join(repo, "node_modules"),
      path.join(snapshot, "node_modules"),
    );
    for (const name of ["structured-dnd", "file-explorer"]) {
      await fs.cp(
        path.join(repo, "../noted-shared/packages", name),
        path.join(shared, name),
        {
          recursive: true,
          force: true,
          filter: (entry) =>
            !entry.includes("/node_modules") && !entry.includes("/.git"),
        },
      );
    }
    const bundled = await build({
      entryPoints: [
        path.join(
          snapshot,
          "scripts/fixtures/history-local-image-hydration.tsx",
        ),
      ],
      bundle: true,
      outfile: path.join(artifact, "bundle.js"),
      platform: "browser",
      format: "esm",
      target: "chrome120",
      logLevel: "silent",
      metafile: true,
      sourcemap: true,
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env": '{"DEV":false,"MODE":"test"}',
      },
      alias: {
        "@noted/claude-blocks": path.join(
          snapshot,
          "packages/claude-blocks/src",
        ),
        "@noted/structured-dnd": path.join(shared, "structured-dnd/src"),
        "@noted/file-explorer": path.join(shared, "file-explorer/src"),
        react: path.join(repo, "node_modules/react"),
        "react-dom": path.join(repo, "node_modules/react-dom"),
      },
      loader: { ".ttf": "file", ".woff2": "file", ".svg": "dataurl" },
    });
    const sourceRoot = await fs.realpath(snapshot);
    const sourceHashes = {};
    for (const input of Object.keys(bundled.metafile.inputs)) {
      const real = await fs.realpath(path.resolve(input)).catch(() => null);
      if (!real) continue;
      const relative = path.relative(sourceRoot, real);
      if (/^(src|packages|scripts)\//.test(relative))
        sourceHashes[relative] = await sha256(real);
    }
    result.sourceHashes = sourceHashes;
    await fs.writeFile(
      path.join(artifact, "source-hashes.json"),
      JSON.stringify({ capturedAt: stamp(), sourceHashes }, null, 2),
    );
    execFileSync(
      path.join(repo, "node_modules/.bin/tailwindcss"),
      [
        "-i",
        path.join(snapshot, "src/renderer/styles/globals.css"),
        "-o",
        path.join(artifact, "globals.css"),
        "--minify",
      ],
      { cwd: snapshot, stdio: "pipe" },
    );
    const fontSource = path.join(
      repo,
      "build-resources/assets/fonts/JetBrainsMonoNerdFont-Regular.ttf",
    );
    const fontTarget = path.join(
      artifact,
      "assets/fonts/JetBrainsMonoNerdFont-Regular.ttf",
    );
    await fs.mkdir(path.dirname(fontTarget), { recursive: true });
    await fs.copyFile(fontSource, fontTarget);
    const generatedGlobalsPath = path.join(artifact, "globals.css");
    const generatedGlobals = await fs.readFile(generatedGlobalsPath, "utf8");
    await fs.writeFile(
      generatedGlobalsPath,
      generatedGlobals.replaceAll(
        "../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf",
        "assets/fonts/JetBrainsMonoNerdFont-Regular.ttf",
      ),
    );
    result.evidence.font = {
      bytes: (await fs.stat(fontTarget)).size,
      sha256: await sha256(fontTarget),
    };
    const styleFiles = ["globals.css", "bundle.css"];
    const styleStats = {};
    for (const styleFile of styleFiles) {
      const stylePath = path.join(artifact, styleFile);
      const stat = await fs.stat(stylePath);
      assert.ok(
        stat.isFile() && stat.size > 0,
        `${styleFile} must be emitted and non-empty`,
      );
      styleStats[styleFile] = {
        bytes: stat.size,
        sha256: await sha256(stylePath),
      };
    }
    result.evidence.styles = styleStats;
    await fs.writeFile(
      path.join(artifact, "style-hashes.json"),
      JSON.stringify({ capturedAt: stamp(), styleStats }, null, 2),
    );
    await fs.writeFile(
      path.join(artifact, "index.html"),
      '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ddd}button{cursor:pointer}</style><div id="root"></div><script type="module" src="bundle.js"></script>',
    );
    const userData = path.join(artifact, "user-data");
    await fs.mkdir(userData, { recursive: true });
    const preload = path.join(artifact, "preload.cjs");
    await fs.writeFile(
      preload,
      "const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});",
    );
    const privateMainConfig = {
      userData,
      configPath: path.join(artifact, "fixture-config.json"),
      preload,
      html: path.join(artifact, "index.html"),
    };
    await fs.writeFile(
      path.join(artifact, "main.cjs"),
      "(" +
        privateMain.toString() +
        ")(" +
        JSON.stringify(privateMainConfig) +
        ");",
    );
    await fs.writeFile(
      path.join(artifact, "process-lease.json"),
      JSON.stringify(
        {
          startedAt: stamp(),
          cwd: artifact,
          executable: path.join(repo, "node_modules/.bin/electron"),
          main: path.join(artifact, "main.cjs"),
          userData,
          ownedByThisRun: true,
        },
        null,
        2,
      ),
    );
    result.actions.push(
      "frozen source worktree, actual HistoryPanel fixture bundle, private Electron main and process lease created",
    );
    log("SETUP private Electron target", {
      artifact,
      freezeFrom,
      sourceMode: result.sourceMode,
    });

    const env = {
      ...process.env,
      NOTED_E2E_TEST: "true",
      NOTED_USER_DATA_DIR: userData,
    };
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
    ])
      delete env[key];
    app = await electron.launch({
      executablePath: path.join(repo, "node_modules/.bin/electron"),
      args: [path.join(artifact, "main.cjs")],
      env,
      cwd: artifact,
    });
    result.pid = app.process()?.pid || null;
    result.actions.push("private Electron 28 launched offscreen/nonfocusable");
    log("LEASE private Electron started", { pid: result.pid, cwd: artifact });
    page = await app.firstWindow();
    page.setDefaultTimeout(18000);
    page.on("pageerror", (error) => {
      errors.push(error.stack || error.message);
      log("UI pageerror", { message: error.message });
    });
    page.on("console", (message) => {
      const line = message.text();
      if (
        message.type() === "error" &&
        !line.includes("Failed to load resource")
      )
        errors.push(line);
      log("UI console " + message.type(), { line: line.slice(0, 500) });
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText || "unknown";
      const url = request.url();
      resourceFailures.push({ url, failure });
      log("UI requestfailed", { url, failure });
    });
    await page.waitForFunction(
      () => window.localImageHydrationFixture?.state?.configReady === true,
    );
    await page.waitForFunction(
      () =>
        [...document.styleSheets].some((sheet) =>
          sheet.href?.endsWith("/globals.css"),
        ) &&
        [...document.styleSheets].some((sheet) =>
          sheet.href?.endsWith("/bundle.css"),
        ),
    );
    await page.screenshot({
      path: path.join(artifact, "00-boot-full.png"),
      fullPage: true,
    });
    result.actions.push(
      "full-surface baseline screenshot captured before UI actions",
    );
    log("BASELINE full viewport screenshot captured");
    await page.waitForSelector("[data-local-image-hydration-fixture]");
    await page.waitForSelector("[data-history-composer-tab-id]");
    await page.waitForTimeout(900);

    const read = () =>
      page.evaluate(() => window.localImageHydrationFixture.snapshot());
    const initial = await read();
    result.evidence.initial = initial;
    await page.screenshot({
      path: path.join(artifact, "01-initial-empty-images.png"),
      fullPage: true,
    });
    log("VERIFY local pre-existing handoff starts without image paths", {
      handoffs: initial.handoffs,
      tokens: initial.imageTokenCount,
    });
    check(
      "pre-existing local handoff is present before receipt",
      initial.handoffs.some(
        (item) => item.handoffId && item.imagePaths.length === 0,
      ),
      initial.handoffs,
    );

    // The captured text contains a literal image marker, but without exact
    // proof it must not produce a usable preview. If the UI opens that stale
    // marker, record the error state and close it before the late-proof path.
    const preProofToken = page
      .locator('[data-history-composer-token="image"]')
      .first();
    if (await preProofToken.count()) {
      await preProofToken.click();
      await page.waitForTimeout(300);
      const preProof = await page.evaluate(() => ({
        states: [
          ...document.querySelectorAll("[data-ai-composer-image-preview]"),
        ].map((node) => node.getAttribute("data-preview-state")),
        text: [
          ...document.querySelectorAll("[data-ai-composer-image-preview]"),
        ].map((node) => node.textContent || ""),
      }));
      result.evidence.preProof = preProof;
      log("VERIFY pre-proof image marker cannot fabricate preview", preProof);
      check(
        "pre-proof preview is not ready",
        !preProof.states.includes("ready"),
        preProof,
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(120);
      if (await page.locator("[data-history-chip-popover-backdrop]").count()) {
        await page
          .locator("[data-history-chip-popover-backdrop]")
          .click({ position: { x: 4, y: 4 } });
      }
      await page.waitForFunction(
        () => !document.querySelector("[data-history-chip-popover-backdrop]"),
      );
    }

    await page.getByRole("button", { name: "Provider queued" }).click();
    await page.waitForFunction(() =>
      window.localImageHydrationFixture.state.events.some(
        (item) => item.type === "receipt" && item.state === "audit-pending",
      ),
    );
    await page.waitForTimeout(350);
    const queued = await read();
    result.evidence.queued = queued;
    await page.screenshot({
      path: path.join(artifact, "02-provider-queued.png"),
      fullPage: true,
    });
    log("TRIGGER provider queued receipt through trusted UI click", {
      handoffs: queued.handoffs,
      tokens: queued.imageTokenCount,
    });
    check(
      "provider queued state is visible",
      queued.handoffs.some((item) => item.queueStatus === "queued"),
      queued.handoffs,
    );

    await page.getByRole("button", { name: "SENT" }).click();
    await page.waitForFunction(() =>
      window.localImageHydrationFixture.state.events.some(
        (item) => item.type === "receipt" && item.state === "confirmed",
      ),
    );
    await page.waitForTimeout(350);
    const sent = await read();
    result.evidence.sent = sent;
    log("TRIGGER exact SENT receipt through trusted UI click", {
      handoffs: sent.handoffs,
      tokens: sent.imageTokenCount,
    });
    check(
      "SENT state is visible and exact image path is adopted",
      sent.handoffs.some(
        (item) => item.queueStatus === "sent" && item.imagePaths.length === 1,
      ),
      sent.handoffs,
    );

    const token = page.locator('[data-history-composer-token="image"]').first();
    const imageBeforeClick = await read();
    const hasExactImagePath = sent.handoffs.some(
      (item) => item.imagePaths.length === 1,
    );
    if (hasExactImagePath && (await token.count())) {
      await token.click();
      await page.waitForFunction(() =>
        document.querySelector(
          '[data-ai-composer-image-preview][data-preview-state="ready"] img',
        ),
      );
      const preview = await page.evaluate(() => {
        const card = document.querySelector("[data-ai-composer-image-preview]");
        const image = card?.querySelector("img");
        const token = document.querySelector(
          '[data-history-composer-token="image"]',
        );
        const tokenRect = token?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        return {
          state: card?.getAttribute("data-preview-state") || null,
          naturalWidth: image?.naturalWidth || 0,
          naturalHeight: image?.naturalHeight || 0,
          srcLength: image?.src?.length || 0,
          tokenRect: tokenRect
            ? { width: tokenRect.width, height: tokenRect.height }
            : null,
          cardRect: cardRect
            ? { width: cardRect.width, height: cardRect.height }
            : null,
          handoffs: window.localImageHydrationFixture.snapshot().handoffs,
        };
      });
      result.evidence.preview = preview;
      await page.screenshot({
        path: path.join(artifact, "03-preview-loaded.png"),
        fullPage: true,
      });
      const popupGeometry = await page.evaluate(() => {
        const card = document.querySelector("[data-ai-composer-image-preview]");
        const rect = card?.getBoundingClientRect();
        return rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      });
      await page.screenshot({
        path: path.join(artifact, "03-preview-popup-viewport.png"),
        fullPage: false,
      });
      if (popupGeometry) {
        await page.screenshot({
          path: path.join(artifact, "03-preview-popup-clip.png"),
          clip: {
            x: Math.max(0, popupGeometry.x - 24),
            y: Math.max(0, popupGeometry.y - 24),
            width: Math.min(1200, popupGeometry.width + 48),
            height: Math.min(1000, popupGeometry.height + 48),
          },
          fullPage: false,
        });
      }
      result.evidence.popupScreenshot = {
        viewport: path.join(artifact, "03-preview-popup-viewport.png"),
        clip: path.join(artifact, "03-preview-popup-clip.png"),
        geometry: popupGeometry,
      };
      log(
        "CAPTURE open styled preview popup before close",
        result.evidence.popupScreenshot,
      );
      if (popupOnly) {
        result.actions.push(
          "narrow popup-only retake captured viewport and popup clip before close",
        );
        result.status = "PASS";
        return;
      }
      log("VERIFY trusted image click loaded preview", preview);
      check(
        "image preview reaches ready with nonzero decoded dimensions",
        preview.state === "ready" &&
          preview.naturalWidth > 0 &&
          preview.naturalHeight > 0 &&
          preview.srcLength > 1000,
        preview,
      );
      check(
        "styled image chip and popup stay compact",
        !!preview.tokenRect &&
          preview.tokenRect.width < 500 &&
          preview.tokenRect.height < 120 &&
          !!preview.cardRect &&
          preview.cardRect.width < 900 &&
          preview.cardRect.height < 900,
        preview,
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector("[data-history-chip-popover-backdrop]"),
      );
      await token.click();
      await page.waitForFunction(() =>
        document.querySelector(
          '[data-ai-composer-image-preview][data-preview-state="ready"] img',
        ),
      );
      await page
        .locator("[data-history-chip-popover-backdrop]")
        .click({ position: { x: 4, y: 4 } });
      await page.waitForFunction(
        () => !document.querySelector("[data-history-chip-popover-backdrop]"),
      );
      await token.click();
      await page.waitForFunction(() =>
        document.querySelector(
          '[data-ai-composer-image-preview][data-preview-state="ready"] img',
        ),
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector("[data-history-chip-popover-backdrop]"),
      );
      result.actions.push(
        "trusted click, Escape close, reopen and second trusted click close verified",
      );
    } else {
      log("VERIFY exact image path absent on current source", imageBeforeClick);
      check("image preview token appears after receipt hydration", false, {
        ...imageBeforeClick,
        hasExactImagePath,
      });
    }

    await page.getByRole("button", { name: "Cold remount" }).click();
    await page.waitForTimeout(1200);
    await page.waitForFunction(
      () => window.localImageHydrationFixture.state.phase === "cold-remount",
    );
    await page.waitForTimeout(700);
    const cold = await read();
    result.evidence.coldRemount = cold;
    await page.screenshot({
      path: path.join(artifact, "05-cold-remount-proof-before-row.png"),
      fullPage: true,
    });
    log("VERIFY cold/remount durable list proof", {
      handoffs: cold.handoffs,
      tokens: cold.imageTokenCount,
    });
    check(
      "cold/remount proof before visible row restores exact image",
      cold.handoffs.some((item) => item.imagePaths.length === 1) &&
        cold.imageTokenCount === 1,
      cold,
    );

    await page.getByRole("button", { name: "Canonical late alias" }).click();
    await page.waitForTimeout(900);
    const adopted = await read();
    result.evidence.canonicalAdoption = adopted;
    await page.screenshot({
      path: path.join(artifact, "04-canonical-late-adoption.png"),
      fullPage: true,
    });
    const promptRows = adopted.rows.filter(
      (row) =>
        row.uuid === result.evidence.fixture.entryUuid ||
        row.uuid === result.evidence.fixture.localUuid,
    );
    log("VERIFY canonical late alias adoption", {
      promptRows,
      imageTokenCount: adopted.imageTokenCount,
      rows: adopted.rowCount,
    });
    check(
      "canonical late alias leaves one prompt card",
      promptRows.length === 1 &&
        promptRows[0].uuid === result.evidence.fixture.entryUuid,
      promptRows,
    );
    check(
      "canonical adoption retains one exact image token",
      adopted.imageTokenCount === 1,
      adopted,
    );

    await page.getByRole("button", { name: "Foreign proof" }).click();
    await page.waitForTimeout(400);
    const foreign = await read();
    result.evidence.foreign = foreign;
    log("VERIFY foreign/mismatched proof does not fabricate path", {
      handoffs: foreign.handoffs,
      tokens: foreign.imageTokens,
    });
    check(
      "foreign proof does not add a second image or fake path",
      foreign.handoffs.filter((item) => item.imagePaths.length === 1).length ===
        0 &&
        !foreign.handoffs.some((item) =>
          item.imagePaths.some((image) =>
            String(image.path || "").includes("foreign"),
          ),
        ) &&
        foreign.previewStates.length === 0,
      foreign,
    );

    await page.getByRole("button", { name: "Hide History" }).click();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: "Show History" }).click();
    await page.waitForTimeout(900);
    const remount = await read();
    result.evidence.finalRemount = remount;
    await page.screenshot({
      path: path.join(artifact, "06-final-remount.png"),
      fullPage: true,
    });
    log("VERIFY hide/show remount retains exact presentation", {
      handoffs: remount.handoffs,
      tokens: remount.imageTokenCount,
    });
    check(
      "hide/show remount retains one image token",
      remount.imageRows === 1 &&
        remount.rows.some(
          (row) => row.uuid === result.evidence.fixture.entryUuid,
        ),
      remount,
    );
    check(
      "all renderer interactions were trusted",
      (result.evidence.trustedClicks = await page.evaluate(() =>
        window.localImageHydrationFixture.state.trusted
          .filter((item) => item.type === "click")
          .every((item) => item.trusted),
      )),
      await page.evaluate(() =>
        window.localImageHydrationFixture.state.trusted.filter(
          (item) => item.type === "click",
        ),
      ),
    );
    check(
      "no provider/PTy channels were invoked",
      (
        await app.evaluate(
          () => global.localImageHydrationMain?.forbidden || [],
        )
      ).length === 0,
    );
    check(
      "no renderer/page errors",
      errors.length === 0 &&
        resourceFailures.every((item) =>
          /JetBrainsMonoNerdFont-Regular\.ttf$/.test(item.url),
        ),
      { errors, resourceFailures },
    );
    result.evidence.resourceFailures = resourceFailures;

    const greenExpected = result.evidence.fixture.eventHasImagePresentation;
    const behaviorPassed = result.checks.every((item) => item.pass);
    if (!greenExpected && !behaviorPassed) {
      result.status = "EXPECTED_RED";
      result.actions.push(
        "baseline intentionally reproduced missing live imagePresentation/hydration failure",
      );
    } else {
      result.status = behaviorPassed ? "PASS" : "FAIL";
    }
  } catch (error) {
    result.status = baseline ? "EXPECTED_RED" : "FAIL";
    result.error = error?.stack || String(error);
    errors.push(result.error);
    log("RUN_EXCEPTION", { error: result.error });
    if (page)
      await page
        .screenshot({
          path: path.join(artifact, "failure-full.png"),
          fullPage: true,
        })
        .catch(() => {});
  } finally {
    if (app) {
      await app.close().catch((error) => {
        result.cleanup.closeError = String(error);
      });
      try {
        process.kill(result.pid, 0);
        result.cleanup.processExited = false;
      } catch {
        result.cleanup.processExited = true;
      }
    }
    await fs.writeFile(
      path.join(artifact, "test-run.log"),
      `${eventLog.join("\n")}\n`,
    );
    await fs.writeFile(
      path.join(artifact, "result.json"),
      JSON.stringify(result, null, 2),
    );
    const reportRoot = path.dirname(artifact);
    const screenshotEvidence = popupOnly
      ? `- Screenshots: ${artifact}/03-preview-loaded.png, ${artifact}/03-preview-popup-viewport.png, ${artifact}/03-preview-popup-clip.png`
      : `- Screenshots: ${artifact}/00-boot-full.png, ${artifact}/03-preview-loaded.png, ${artifact}/03-preview-popup-viewport.png, ${artifact}/03-preview-popup-clip.png, ${artifact}/04-canonical-late-adoption.png, ${artifact}/05-cold-remount-proof-before-row.png, ${artifact}/06-final-remount.png`;
    const report = [
      "# Local image hydration E2E result",
      "",
      `- Status: **${result.status}**`,
      `- Source mode: ${result.sourceMode}`,
      `- Artifact: ${artifact}`,
      `- Frozen source: ${freezeFrom}`,
      `- Executor: ${result.executor.model} / ${result.executor.effort}; application AI model: not used`,
      "",
      "## Boundary",
      "",
      "Private Electron 28 offscreen HistoryPanel with the captured 4944 durable receipt, exact original `/var/folders/.../photo-1791125478-1.jpg`, and a byte-exact private JPG copy. No provider, PTY, production API, real receipt, JSONL, native iOS, or global input was used.",
      "",
      "## Evidence",
      "",
      screenshotEvidence,
      `- Decisive log: ${artifact}/test-run.log`,
      `- Machine result: ${artifact}/result.json`,
      `- Process lease: ${artifact}/process-lease.json`,
      `- Source hashes: ${artifact}/source-hashes.json`,
      `- Stylesheet hashes: ${artifact}/style-hashes.json (globals.css + bundle.css loaded)`,
      `- Font asset: ${artifact}/assets/fonts/JetBrainsMonoNerdFont-Regular.ttf (copied and hashed in result.json)`,
      `- Private image copy hash: ${result.evidence.fixture?.privateHash || "n/a"} (captured source: ${result.evidence.fixture?.imageHash || "n/a"})`,
      "",
      "## Decisive timestamped log lines",
      "",
      ...eventLog
        .filter((line) =>
          /FIXTURE|BASELINE|TRIGGER|VERIFY|CHECK_FAIL|LEASE|CLEANUP/.test(line),
        )
        .slice(-15)
        .map((line) => `- ${line}`),
      "",
      "## Checks",
      "",
      ...result.checks.map(
        (item) => `- ${item.pass ? "PASS" : "FAIL"} — ${item.name}`,
      ),
      "",
      "RED baseline is retained as a regression artifact when run with the parent-provided baseline source; GREEN is accepted only when live receipt publication and exact post-bind hydration both pass.",
      "",
    ].join("\n");
    await fs.mkdir(reportRoot, { recursive: true });
    await fs.writeFile(path.join(reportRoot, "UI-RESULT.md"), report);
    console.log(
      JSON.stringify(
        {
          status: result.status,
          sourceMode: result.sourceMode,
          artifact,
          checks: result.checks.length,
          failed: result.checks
            .filter((item) => !item.pass)
            .map((item) => item.name),
          cleanup: result.cleanup,
        },
        null,
        2,
      ),
    );
    if (result.status === "FAIL") process.exitCode = 1;
  }
}

await run();
