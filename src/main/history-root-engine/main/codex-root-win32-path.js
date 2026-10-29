// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// Node 18.18.2 win32 normalize/resolve root and drive rules, with components
// and intermediate strings on the existing arena. This is History pathname
// normalization, not filesystem admission or a Windows native acceptance.
const text = require('./history-paged-text');
const separator = c => c === '/' || c === '\\';
const drive = c => !!c && /^[A-Za-z]$/.test(c);
const concat = (arena, ...parts) => text.concat(parts, '', arena);
function root(value, arena) {
  const r = text.reader(value), n = value.length;
  let end = 0, device = '', absolute = false, uncOnly = false;
  if (n === 1) { if (separator(r.at(0))) { end = 1; absolute = true; } }
  else if (separator(r.at(0))) {
    absolute = true;
    if (separator(r.at(1))) {
      let at = 2, last = at;
      while (at < n && !separator(r.at(at))) at++;
      if (at < n && at !== last) {
        const server = value.slice(last, at); last = at;
        while (at < n && separator(r.at(at))) at++;
        if (at < n && at !== last) {
          last = at; while (at < n && !separator(r.at(at))) at++;
          if (at === n || at !== last) {
            device = concat(arena, '\\\\', server, '\\', value.slice(last, at));
            end = at; uncOnly = at === n;
          }
        }
      }
    } else end = 1;
  } else if (drive(r.at(0)) && r.at(1) === ':') {
    device = value.slice(0, 2); end = 2;
    if (n > 2 && separator(r.at(2))) { absolute = true; end = 3; }
  }
  return { end, device, absolute, uncOnly };
}
function normalizeTail(value, allowAboveRoot, arena) {
  const r = text.reader(value), parts = arena.make('array'); let begin = 0;
  for (let at = 0; at <= value.length; at++) {
    if (at < value.length && !separator(r.at(at))) continue;
    const part = value.slice(begin, at); begin = at + 1;
    if (!part.length || text.equal(part, '.')) continue;
    if (text.equal(part, '..')) {
      if (parts.length && !text.equal(parts[parts.length - 1], '..')) parts.pop();
      else if (allowAboveRoot) parts.push('..');
    } else parts.push(part);
  }
  arena.metrics.maxWin32PathComponentsOnDisk = Math.max(arena.metrics.maxWin32PathComponentsOnDisk || 0, parts.length);
  return text.concat(parts, '\\', arena);
}
function normalizeWin32(value, arena) {
  if (!value.length) return '.';
  if (value.length === 1) return text.equal(value, '/') ? '\\' : value;
  const parsed = root(value, arena);
  if (parsed.uncOnly) return concat(arena, parsed.device, '\\');
  let tail = normalizeTail(value.slice(parsed.end), !parsed.absolute, arena);
  if (!tail.length && !parsed.absolute) tail = '.';
  if (tail.length && separator(text.reader(value).at(value.length - 1))) tail = concat(arena, tail, '\\');
  return concat(arena, parsed.device, parsed.absolute ? '\\' : '', tail);
}
function resolveWin32(base, value, arena, environment) {
  const runtime = environment || { cwd: () => process.cwd(), driveCwd: d => process.env['=' + d] };
  let device = '', tail = '', absolute = false;
  for (let i = 1; i >= -1; i--) {
    let part;
    if (i >= 0) {
      part = i === 1 ? value : base;
      if (!text.isText(part)) throw new TypeError('The cwd argument must be a string');
      if (!part.length) continue;
    } else if (!device.length) part = runtime.cwd();
    else {
      // At this point a device is exactly an ASCII drive letter plus colon.
      // An absolute UNC device has already ended the loop.
      part = runtime.driveCwd(text.small(device, 2)) || runtime.cwd();
      if (part === undefined || !text.equal(part.slice(0, 2).toLowerCase(), device.toLowerCase())
        && text.reader(part).at(2) === '\\') part = concat(arena, device, '\\');
    }
    const parsed = root(part, arena);
    if (parsed.device.length) {
      if (device.length && !text.equal(parsed.device.toLowerCase(), device.toLowerCase())) continue;
      if (!device.length) device = parsed.device;
    }
    if (absolute) { if (device.length) break; }
    else {
      tail = concat(arena, part.slice(parsed.end), '\\', tail); absolute = parsed.absolute;
      if (absolute && device.length) break;
    }
  }
  tail = normalizeTail(tail, !absolute, arena);
  return concat(arena, device, absolute ? '\\' : '', tail) || '.';
}
function normalizeWin32PatchPath(value, cwd, arena, environment) {
  const parsed = root(value, arena);
  return normalizeWin32(parsed.absolute ? value
    : resolveWin32(cwd || (environment ? environment.cwd() : process.cwd()), value, arena, environment), arena);
}
module.exports = { normalizeWin32PatchPath, normalizeWin32, resolveWin32 };

