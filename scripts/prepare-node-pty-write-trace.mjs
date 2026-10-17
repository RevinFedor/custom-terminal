import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNodePtyWriteTrace } from './node-pty-write-trace.mjs';

// Separate entry point: the observer module is also imported by the atomic
// publisher/build validator. Do not create a top-level-await import cycle.
const projectDir = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const changed = await prepareNodePtyWriteTrace(projectDir);
console.log('[node-pty] scalar write observer ' + (changed ? 'prepared' : 'already current'));
