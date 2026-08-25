'use strict';

const fs = require('fs');
const path = require('path');

class StorageDeletionAudit {
  constructor({
    filePath,
    appendFile = (target, content) => fs.promises.appendFile(target, content, { encoding: 'utf8', mode: 0o600 }),
    mkdir = (target) => fs.promises.mkdir(target, { recursive: true, mode: 0o700 }),
    now = () => Date.now(),
  } = {}) {
    this.filePath = filePath ? path.resolve(String(filePath)) : null;
    this.appendFile = appendFile;
    this.mkdir = mkdir;
    this.now = now;
    this.writeInflight = Promise.resolve();
  }

  record(event) {
    if (!this.filePath) return Promise.reject(new Error('Storage deletion audit path is unavailable'));
    const row = {
      version: 1,
      timestamp: new Date(this.now()).toISOString(),
      ...(event && typeof event === 'object' ? event : {}),
    };
    const line = `${JSON.stringify(row)}\n`;
    const write = this.writeInflight.then(async () => {
      await this.mkdir(path.dirname(this.filePath));
      await this.appendFile(this.filePath, line);
    });
    this.writeInflight = write.catch(() => {});
    return write;
  }
}

module.exports = {
  StorageDeletionAudit,
};
