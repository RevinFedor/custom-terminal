import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const PTY_WRITE_TRACE_ORIGINAL_SHA = '63b605fb25c4e6d237493cd1799b01a8d880d89c78850108aae1853d04b4cdf0';
export const PTY_WRITE_TRACE_SHA = '0914bba346168653252535d2f9e7bb5c4f91135effab862c1998c38f6812d81e';
const hash = value => createHash('sha256').update(value).digest('hex');
const once = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error('[node-pty] write trace patch context changed');
  return text.replace(before, after);
};
const OBSERVER = `// Noted scalar-only observer. It cannot change queue control or throw into it.
function notedPtyWriteTrace(stream, phase, task, written, error) {
    var trace = task && task.notedWriteTrace;
    if (!trace) return;
    try {
        trace.observe({ phase: phase, taskId: task.notedWriteId,
            fdAttempt: task.notedFdAttempt || 0, bytesTotal: task.buffer.byteLength,
            offsetBefore: task.offset,
            offsetAfter: !error && Number.isFinite(written) ? task.offset + written : task.offset,
            writtenBytes: Number.isFinite(written) ? written : null,
            requestedBytes: task.buffer.byteLength - task.offset,
            errorCode: error && typeof error.code === 'string' ? error.code : null,
            queueSize: stream._writeQueue.length,
            aheadCount: phase === 'enqueue' ? stream._writeQueue.length : 0,
            aheadBytesComplete: phase !== 'enqueue' || stream._writeQueue.length <= 128,
            aheadBytes: phase === 'enqueue' ? stream._writeQueue.slice(0, 128).reduce(function (sum, item) {
                return sum + item.buffer.byteLength - item.offset;
            }, 0) : 0,
            complete: !error && Number.isFinite(written) && task.offset + written >= task.buffer.byteLength });
    } catch (_) { /* Diagnostics must never change byte order or queue lifetime. */ }
}
`;

// Exact JS-only instrumentation of the pinned upstream queue, not another
// implementation of its fd writer. Native code, algorithms and retries remain.
export function patchNodePtyWriteTrace(input) {
  const original = String(input);
  if (hash(original) === PTY_WRITE_TRACE_SHA) return original;
  if (hash(original) !== PTY_WRITE_TRACE_ORIGINAL_SHA) throw Error('[node-pty] unixTerminal.js write trace source drift');
  let text = once(original, 'var CustomWriteStream = /** @class */ (function () {',
    OBSERVER + 'var CustomWriteStream = /** @class */ (function () {');
  text = once(text, '        this._writeQueue = [];\n',
    '        this._writeQueue = [];\n        this.notedWriteTraceVersion = 1;\n        this.notedWriteSequence = 0;\n');
  text = once(text, '    CustomWriteStream.prototype.dispose = function () {\n',
    '    CustomWriteStream.prototype.dispose = function () {\n'
      + '        for (var task of this._writeQueue) notedPtyWriteTrace(this, "dispose", task);\n');
  text = once(text, '            this._writeQueue.push({ buffer: buffer, offset: 0 });',
    '            var task = { buffer: buffer, offset: 0, notedWriteId: ++this.notedWriteSequence };\n'
      + '            var trace = this[Symbol.for("noted.pty.writeTrace.v1")];\n'
      + '            if (trace && typeof trace.observe === "function") task.notedWriteTrace = trace;\n'
      + '            notedPtyWriteTrace(this, "enqueue", task);\n'
      + '            this._writeQueue.push(task);');
  text = once(text, '        fs.write(this._fd, task.buffer, task.offset, function (err, written) {\n',
    '        task.notedFdAttempt = (task.notedFdAttempt || 0) + 1;\n'
      + '        notedPtyWriteTrace(this, "fd-call", task);\n'
      + '        fs.write(this._fd, task.buffer, task.offset, function (err, written) {\n'
      + '            notedPtyWriteTrace(_this, "fd-callback", task, written, err);\n');
  text = once(text, '                    _this._writeQueue.length = 0;',
    '                    for (var queued of _this._writeQueue) notedPtyWriteTrace(_this, "abandoned", queued, undefined, err);\n'
      + '                    _this._writeQueue.length = 0;');
  if (hash(text) !== PTY_WRITE_TRACE_SHA) throw Error('[node-pty] write trace output SHA mismatch');
  return text;
}

export async function prepareNodePtyWriteTrace(projectDir) {
  const file = path.join(projectDir, 'node_modules/node-pty/lib/unixTerminal.js');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('[node-pty] expected regular write stream module');
  const before = await fs.readFile(file);
  const after = Buffer.from(patchNodePtyWriteTrace(before.toString()));
  if (before.equals(after)) return false;
  // Use the existing atomic publisher: never truncate code mapped/read by a
  // running app. Its already-loaded JS instances remain unchanged.
  const { atomicPublish } = await import('./node-pty-build.mjs');
  if (!(await fs.readFile(file)).equals(before)) throw Error('[node-pty] write trace source changed before publication');
  return atomicPublish(file, after, stat.mode & 0o777);
}

