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
  });


  // Wait for app to fully load
  await mainWindow.waitForLoadState('domcontentloaded');
  await mainWindow.waitForTimeout(2000); // Extra wait for initialization
});

test.afterAll(async () => {

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

  // Close app
  await electronApp.close();
});

test.describe('Session Persistence Tests', () => {
  test('should display Sessions tab', async () => {

    // Take screenshot of initial state
    await mainWindow.screenshot({
      path: path.join(__dirname, '../results/01-initial-state.png')
    });

    // Find Sessions tab button
    const sessionsTab = mainWindow.locator('button.note-tab[data-tab="sessions"]');

    // Wait for it to be visible
    await expect(sessionsTab).toBeVisible({ timeout: 10000 });

  });

  test('should open Sessions panel', async () => {

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

  });

  test('should display session management buttons', async () => {

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

  });

  test('should open modal when Export Gemini clicked', async () => {

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


    // Close modal (press Escape)
    await mainWindow.keyboard.press('Escape');
    await expect(modal).toHaveClass(/hidden/, { timeout: 2000 });

  });

  test('should show error if session not found', async () => {

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
    }

  });

  test('should list saved sessions', async () => {

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
    }

  });
});

test.describe('Log Analysis', () => {
  test('should not have critical errors in logs', async () => {

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
    }

    // Fail test if critical errors found
    expect(criticalErrors.length).toBe(0);
  });

  test('should log SessionManager operations', async () => {

    const sessionLogs = [
      ...mainLogs.filter(log => log.includes('SessionManager')),
      ...rendererLogs.filter(log => log.includes('SessionManager') || log.includes('[Session]'))
    ];

    // Should have at least some session-related logs from our tests
    expect(sessionLogs.length).toBeGreaterThan(0);

  });
});
