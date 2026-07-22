const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { exportDiagnosticLog } = require('../diagnostic-log-export');

const ALLOWED_RANGE_MINUTES = new Set([15, 60, 24 * 60]);

function diagnosticFileName(now) {
  return `noted-terminal-diagnostics-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
}

function register({ getMainWindow, getMainLogPath, isDev }) {
  ipcMain.handle('diagnostics:export-log', async (event, request = {}) => {
    const requestedRange = Number(request.rangeMinutes);
    const rangeMinutes = ALLOWED_RANGE_MINUTES.has(requestedRange) ? requestedRange : 60;
    const includeMessageText = request.includeMessageText === true;
    const now = new Date();
    const mainLogPath = getMainLogPath?.();

    if (!mainLogPath) return { success: false, error: 'Путь к логу приложения пока недоступен' };

    const owner = BrowserWindow.fromWebContents(event.sender) || getMainWindow?.() || BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Сохранить диагностические логи',
      defaultPath: path.join(app.getPath('downloads'), diagnosticFileName(now)),
      buttonLabel: 'Создать TXT',
      filters: [{ name: 'Text', extensions: ['txt'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const saveResult = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);

    if (saveResult.canceled || !saveResult.filePath) return { success: false, cancelled: true };

    const destinationPath = saveResult.filePath.toLowerCase().endsWith('.txt')
      ? saveResult.filePath
      : `${saveResult.filePath}.txt`;
    const toMs = now.getTime();
    const fromMs = toMs - rangeMinutes * 60 * 1000;

    console.log(
      '[DiagnosticExport] start rangeMinutes=' + rangeMinutes +
      ' includeMessageText=' + includeMessageText +
      ' destination=' + destinationPath,
    );

    try {
      const result = await exportDiagnosticLog({
        sourcePaths: [`${mainLogPath}.old`, mainLogPath],
        destinationPath,
        fromMs,
        toMs,
        includeMessageText,
        appVersion: app.getVersion(),
        environment: isDev ? 'development' : 'production',
      });
      console.log(
        '[DiagnosticExport] done bytes=' + result.bytes +
        ' selectedLines=' + result.selectedLines +
        ' droppedLines=' + result.droppedLines +
        ' redactions=' + result.redactions.redactions,
      );
      return { success: true, ...result };
    } catch (error) {
      console.error('[DiagnosticExport] failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}

module.exports = { register };
