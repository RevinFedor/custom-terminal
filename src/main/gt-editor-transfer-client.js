const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const GT_FILE_TRANSFER_CLIPBOARD_FORMAT = 'application/x-gt-editor-file-transfer-v1';
const GT_EDITOR_DISCOVERY_FILE = process.env.GT_EDITOR_API_DISCOVERY_FILE
  ? path.resolve(process.env.GT_EDITOR_API_DISCOVERY_FILE)
  : path.join(os.homedir(), '.noted-terminal', 'gt-editor-api.json');

function parseTransferTicket(buffer) {
  if (!buffer || buffer.length === 0) return null;
  let value;
  try { value = JSON.parse(Buffer.from(buffer).toString('utf8')); } catch { return null; }
  if (value?.schema !== 'gt-editor-file-transfer/v1') return null;
  if (typeof value.handoffId !== 'string' || !value.handoffId) return null;
  if (value.expiresAt && Number(value.expiresAt) < Date.now()) return null;
  return value;
}

function readGtEditorDiscovery(fsImpl = fs) {
  let discovery;
  try { discovery = JSON.parse(fsImpl.readFileSync(GT_EDITOR_DISCOVERY_FILE, 'utf8')); }
  catch { return null; }
  if (!discovery?.baseUrl || !discovery?.token) return null;
  return discovery;
}

function requestJson(targetUrl, token, body, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const encoded = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = transport.request(parsed, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': encoded.length,
      },
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && payload) {
          resolve(payload);
          return;
        }
        const error = new Error(payload?.error || `GT Editor HTTP ${res.statusCode}`);
        error.code = payload?.code || 'gt_editor_request_failed';
        error.status = res.statusCode;
        reject(error);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('GT Editor transfer timed out')));
    req.on('error', reject);
    req.end(encoded);
  });
}

class GtEditorTransferClient {
  constructor({ clipboard, db, projectPromptCatalog = null, broadcast = null } = {}) {
    if (!clipboard) throw new Error('GtEditorTransferClient requires clipboard');
    if (!db) throw new Error('GtEditorTransferClient requires db');
    this.clipboard = clipboard;
    this.db = db;
    this.projectPromptCatalog = projectPromptCatalog;
    this.broadcast = typeof broadcast === 'function' ? broadcast : null;
  }

  readTicket() {
    let buffer = null;
    try { buffer = this.clipboard.readBuffer(GT_FILE_TRANSFER_CLIPBOARD_FORMAT); } catch {}
    return parseTransferTicket(buffer);
  }

  async paste({ destinationDir } = {}) {
    const ticket = this.readTicket();
    if (!ticket) {
      const error = new Error('В буфере нет подготовленного файла GT Editor');
      error.code = 'no_gt_transfer';
      throw error;
    }
    if (typeof destinationDir !== 'string' || !path.isAbsolute(destinationDir)) {
      const error = new Error('Не выбрана папка назначения');
      error.code = 'destination_required';
      throw error;
    }
    let stat;
    try { stat = fs.statSync(destinationDir); } catch {}
    if (!stat?.isDirectory()) {
      const error = new Error('Папка назначения недоступна');
      error.code = 'destination_unavailable';
      throw error;
    }

    const discovery = readGtEditorDiscovery();
    if (!discovery) {
      const error = new Error('GT Editor не запущен или его Application API недоступен');
      error.code = 'gt_editor_unavailable';
      throw error;
    }
    const response = await requestJson(
      `${String(discovery.baseUrl).replace(/\/+$/, '')}/api/file-transfer/commit`,
      discovery.token,
      { handoffId: ticket.handoffId, destinationDir },
    );
    if (!response?.ok || !response.transfer?.newPath) {
      const error = new Error(response?.error || 'GT Editor не завершил перенос');
      error.code = response?.code || 'transfer_not_committed';
      throw error;
    }

    const transfer = response.transfer;
    if (transfer.oldPath && transfer.newPath && transfer.oldPath !== transfer.newPath) {
      this.db.rewriteFilePathReferences(transfer.oldPath, transfer.newPath);
    }
    this.projectPromptCatalog?.invalidate(null, 'gt-file-transfer');
    if (this.broadcast) {
      try { this.broadcast(transfer); } catch {}
    }
    return {
      success: true,
      handoffId: ticket.handoffId,
      oldPath: transfer.oldPath || ticket.uri || null,
      newPath: transfer.newPath,
      displayName: transfer.displayName || path.basename(transfer.newPath),
      idempotent: transfer.idempotent === true,
    };
  }
}

module.exports = {
  GT_EDITOR_DISCOVERY_FILE,
  GT_FILE_TRANSFER_CLIPBOARD_FORMAT,
  GtEditorTransferClient,
  parseTransferTicket,
  readGtEditorDiscovery,
  requestJson,
};
