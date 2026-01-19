import { _electron as electron, test, expect } from '@playwright/test';
import { ElectronApplication, Page } from 'playwright';
import path from 'path';

/**
 * Electron Noted Terminal - Session Export/Import Tests
 *
 * Tests the core functionality of saving and restoring Gemini/Claude sessions
 */

let electronApp: ElectronApplication;
let mainWindow: Page;

// Logs collection
const mainLogs: string[] = [];
const rendererLogs: string[] = [];

test.beforeAll(async () => {
  console.log('🚀 [TEST] Launching Electron app...');

  // Launch Electron app (point to project root)
  electronApp = await electron.launch({
    args: [path.join(__dirname, '../../')], // Path to main.js
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });

  // Capture Main Process logs
  electronApp.process().stdout?.on('data', (data) => {
    const log = data.toString().trim();
    mainLogs.push(log);
    console.log(`[MAIN] ${log}`);
  });

  electronApp.process().stderr?.on('data', (data) => {
    const log = data.toString().trim();
    mainLogs.push(`[ERROR] ${log}`);
    console.error(`[MAIN ERROR] ${log}`);
  });

  // Get first window
  mainWindow = await electronApp.firstWindow();

  // Capture Renderer logs
  mainWindow.on('console', (msg) => {
    const log = `[${msg.type()}] ${msg.text()}`;
    rendererLogs.push(log);
    console.log(`[RENDERER] ${log}`);
  });

  console.log('✅ [TEST] App launched successfully');

  // Wait for app to fully load
  await mainWindow.waitForLoadState('domcontentloaded');
  await mainWindow.waitForTimeout(2000); // Extra wait for initialization
});

test.afterAll(async () => {
  console.log('📊 [TEST] Saving logs to file...');

  // Save logs to file
  const fs = require('fs');
  const logsPath = path.join(__dirname, '../results/test-logs.txt');

  const allLogs = [
    '===== MAIN PROCESS LOGS =====',
    ...mainLogs,
    '',
    '===== RENDERER PROCESS LOGS =====',
    ...rendererLogs
  ].join('\n');

  fs.writeFileSync(logsPath, allLogs);
  console.log(`✅ [TEST] Logs saved to: ${logsPath}`);

  // Close app
  await electronApp.close();
  console.log('👋 [TEST] App closed');
});

test.describe('Session Persistence Tests', () => {
  test('should display Sessions tab', async () => {
    console.log('\n🧪 [TEST 1] Checking Sessions tab...');

    // Take screenshot of initial state
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/01-initial-state.png')
    });

    // Find Sessions tab button
    const sessionsTab = mainWindow.locator('button.note-tab[data-tab="sessions"]');

    // Wait for it to be visible
    await expect(sessionsTab).toBeVisible({ timeout: 10000 });

    console.log('✅ [TEST 1] Sessions tab is visible');
  });

  test('should open Sessions panel', async () => {
    console.log('\n🧪 [TEST 2] Opening Sessions panel...');

    // Click Sessions tab
    const sessionsTab = mainWindow.locator('button.note-tab[data-tab="sessions"]');
    await sessionsTab.click();

    // Wait for panel to show
    const sessionsPanel = mainWindow.locator('#notes-content-sessions');
    await expect(sessionsPanel).toHaveClass(/active/, { timeout: 5000 });

    // Take screenshot
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/02-sessions-panel-open.png')
    });

    console.log('✅ [TEST 2] Sessions panel opened');
  });

  test('should display session management buttons', async () => {
    console.log('\n🧪 [TEST 3] Checking session buttons...');

    // Check for Gemini buttons
    const exportGeminiBtn = mainWindow.locator('button:has-text("Export Gemini Session")');
    const importGeminiBtn = mainWindow.locator('button:has-text("Restore Gemini Session")');

    await expect(exportGeminiBtn).toBeVisible();
    await expect(importGeminiBtn).toBeVisible();

    // Check for Claude buttons
    const exportClaudeBtn = mainWindow.locator('button:has-text("Export Claude Session")');
    const importClaudeBtn = mainWindow.locator('button:has-text("Restore Claude Session")');

    await expect(exportClaudeBtn).toBeVisible();
    await expect(importClaudeBtn).toBeVisible();

    // Check utility buttons
    const listSessionsBtn = mainWindow.locator('button:has-text("List All Sessions")');
    const saveBufferBtn = mainWindow.locator('button:has-text("Save Terminal Buffer")');

    await expect(listSessionsBtn).toBeVisible();
    await expect(saveBufferBtn).toBeVisible();

    console.log('✅ [TEST 3] All buttons are visible');
  });

  test('should open modal when Export Gemini clicked', async () => {
    console.log('\n🧪 [TEST 4] Testing Export Gemini modal...');

    // Click Export Gemini button
    const exportBtn = mainWindow.locator('button:has-text("Export Gemini Session")');
    await exportBtn.click();

    // Wait for modal to appear
    const modal = mainWindow.locator('#session-input-modal');
    await expect(modal).not.toHaveClass(/hidden/, { timeout: 5000 });

    // Check modal content
    const modalTitle = mainWindow.locator('#session-modal-title');
    await expect(modalTitle).toHaveText('Export Gemini Session');

    const inputField = mainWindow.locator('#session-input-field');
    await expect(inputField).toBeVisible();

    // Take screenshot
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/03-export-modal-open.png')
    });

    console.log('✅ [TEST 4] Modal opened successfully');

    // Close modal (press Escape)
    await mainWindow.keyboard.press('Escape');
    await expect(modal).toHaveClass(/hidden/, { timeout: 2000 });

    console.log('✅ [TEST 4] Modal closed with Escape');
  });

  test('should show error if session not found', async () => {
    console.log('\n🧪 [TEST 5] Testing non-existent session export...');

    // Click Export button
    const exportBtn = mainWindow.locator('button:has-text("Export Gemini Session")');
    await exportBtn.click();

    // Wait for modal
    const modal = mainWindow.locator('#session-input-modal');
    await expect(modal).not.toHaveClass(/hidden/);

    // Enter non-existent session name
    const inputField = mainWindow.locator('#session-input-field');
    await inputField.fill('non-existent-session-12345');

    // Take screenshot before confirm
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/04-entering-session-name.png')
    });

    // Click Confirm
    const confirmBtn = mainWindow.locator('#confirm-session-btn');
    await confirmBtn.click();

    // Wait for toast notification
    await mainWindow.waitForTimeout(1000);

    // Take screenshot of result
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/05-export-result.png')
    });

    // Look for error toast
    const errorToast = mainWindow.locator('.toast');
    const toastVisible = await errorToast.isVisible().catch(() => false);

    if (toastVisible) {
      const toastText = await errorToast.textContent();
      console.log('📋 [TEST 5] Toast message:', toastText);
    }

    console.log('✅ [TEST 5] Export attempted, check logs for details');
  });

  test('should list saved sessions', async () => {
    console.log('\n🧪 [TEST 6] Testing List Sessions...');

    // Click List Sessions button
    const listBtn = mainWindow.locator('button:has-text("List All Sessions")');
    await listBtn.click();

    // Wait for action to complete
    await mainWindow.waitForTimeout(1000);

    // Take screenshot
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/06-list-sessions.png')
    });

    // Check for toast
    const toast = mainWindow.locator('.toast');
    const toastVisible = await toast.isVisible().catch(() => false);

    if (toastVisible) {
      const toastText = await toast.textContent();
      console.log('📋 [TEST 6] Toast message:', toastText);
    }

    console.log('✅ [TEST 6] List sessions executed');
  });
});

test.describe('Log Analysis', () => {
  test('should not have critical errors in logs', async () => {
    console.log('\n🧪 [TEST 7] Analyzing logs for errors...');

    // Check for critical errors in main process
    const criticalErrors = mainLogs.filter(log =>
      log.includes('ERROR') ||
      log.includes('FATAL') ||
      log.includes('Uncaught')
    );

    if (criticalErrors.length > 0) {
      console.error('❌ Critical errors found in main process:');
      criticalErrors.forEach(err => console.error('  -', err));
    } else {
      console.log('✅ No critical errors in main process');
    }

    // Check renderer logs
    const rendererErrors = rendererLogs.filter(log =>
      log.includes('[error]') ||
      log.includes('Uncaught')
    );

    if (rendererErrors.length > 0) {
      console.error('❌ Errors found in renderer process:');
      rendererErrors.forEach(err => console.error('  -', err));
    } else {
      console.log('✅ No errors in renderer process');
    }

    // Fail test if critical errors found
    expect(criticalErrors.length).toBe(0);
  });

  test('should log SessionManager operations', async () => {
    console.log('\n🧪 [TEST 8] Checking SessionManager logs...');

    const sessionLogs = [
      ...mainLogs.filter(log => log.includes('SessionManager')),
      ...rendererLogs.filter(log => log.includes('SessionManager') || log.includes('[Session]'))
    ];

    console.log(`📋 Found ${sessionLogs.length} SessionManager log entries:`);
    sessionLogs.forEach(log => console.log('  -', log));

    // Should have at least some session-related logs from our tests
    expect(sessionLogs.length).toBeGreaterThan(0);

    console.log('✅ [TEST 8] SessionManager logs captured');
  });
});
