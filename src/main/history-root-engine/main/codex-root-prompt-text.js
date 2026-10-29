'use strict';

// Read-only adapters for the SAME prompt-carrier semantics. Ordinary text is
// scanned/hashed/compared through immutable leaves, including image envelopes.
// Unknown markup remains literal under the same carrier grammar.
const text = require('./history-paged-text');
const legacy = require('./codex-prompt-audit');
const { createRootImages } = require('./codex-root-images');

function createRootPromptText(arena) {
  const images = createRootImages(arena);
  function auditText(record) {
    if (!legacy.isCodexUserMessageAuditRecord(record)) return '';
    const payload = record.payload || {};
    if (text.isText(payload.message)) return payload.message;
    if (text.isText(payload.text)) return payload.text;
    if (!Array.isArray(payload.content)) return '';
    return text.concat((function* () {
      let imageIndex = 0;
      for (const item of payload.content) {
        if (text.isText(item)) { yield item; continue; }
        const type = text.coerce(item?.type || '');
        if (text.includesAsciiIgnoreCase(type, 'image') || text.isText(item?.image_url) || text.isText(item?.imageUrl)) {
          yield ` [Image #${++imageIndex}] `;
        } else if (text.isText(item?.text)) yield item.text;
        else if (text.isText(item?.value)) yield item.value;
        else if (text.isText(item?.message)) yield item.message;
      }
    })(), '', arena);
  }
  function presentation(record) {
    const raw = auditText(record), paths = images.paths(record?.payload);
    // Preserve the established audit pass followed by the presentation pass.
    return images.normalize(images.normalize(raw, paths, false), paths, true);
  }
  function imageRefs(record) {
    return legacy.isCodexUserMessageAuditRecord(record) ? images.refs(record, auditText(record)) : arena.make('array');
  }
  function matches(left, right) {
    left = text.coerce(left ?? ''); right = text.coerce(right ?? '');
    if (!left.length || !right.length) return false;
    if (text.equal(left, right)) return true;
    if (text.equal(text.replaceLiteral(left, '\r\n', '\n\n'), right)
      || text.equal(text.replaceLiteral(right, '\r\n', '\n\n'), left)
      || text.equal(text.trim(left), right) || text.equal(text.trim(right), left)) return true;
    if (!images.hasMarker(left) && !images.hasMarker(right)) return false;
    return text.equal(images.slots(left), images.slots(right));
  }
  function environment(value) {
    value = text.trim(text.coerce(value || ''));
    return value.startsWith('<environment_context>') && value.endsWith('</environment_context>');
  }
  function aborted(value) {
    value = text.trim(text.coerce(value || ''));
    return /^<turn_aborted>(?:\s|$)/i.test(text.small(value.slice(0, 16), 16));
  }
  function instructions(value) {
    value = text.trim(text.coerce(value || ''));
    if (value.charAt(0) !== '#') return false;
    if (!text.includesAsciiIgnoreCase(value.slice(0, 2000), '<instructions>')) return false;
    const scan = scanner(value);
    try {
      if (!scan.literal('#') || !scan.spaces(true)) return false;
      let name = ''; for (let i=0;i<9 && !scan.done();i++) name+=scan.take();
      if (!['agents.md','claude.md'].includes(name.toLowerCase()) || !scan.spaces(true)
        || !scan.literal('instructions') || !scan.spaces(true) || !scan.literal('for') || !scan.spaces(true)) return false;
      let count=0;while(!scan.done()&&scan.peek()!=='\r'&&scan.peek()!=='\n'){scan.take();count++;}
      if(!count)return false;
      if(scan.done())return true;
      if(scan.peek()==='\r')scan.take();
      return scan.take()==='\n';
    } finally { scan.close(); }
  }
  function goal(value) {
    value = text.trim(text.coerce(value || ''));
    if (text.small(value.slice(0, 23), 23).toLowerCase() !== '<codex_internal_context') return false;
    const close = '</codex_internal_context>';
    if (text.small(value.slice(-close.length), close.length).toLowerCase() !== close) return false;
    const scan=scanner(value);
    try {
      if(!scan.literal('<codex_internal_context')||!scan.spaces(true)||!scan.literal('source='))return false;
      if(!['"',"'"].includes(scan.take())||!scan.literal('goal')||!['"',"'"].includes(scan.take()))return false;
      scan.spaces(false);return scan.take()==='>';
    }finally{scan.close();}
  }
  return { presentation, imageRefs, mergeRefs: images.merge, matches, environment, aborted, instructions, goal,
    fingerprint: value => text.isPagedText(value) ? text.hash(value).slice(0, 16)
      : require('./prompt-audit-fingerprint').promptAuditFingerprint(value) };
}

function scanner(value) {
  const iterator=text.units(value);let next=iterator.next();
  const take=()=>{const char=next.done?'':next.value.char;if(!next.done)next=iterator.next();return char;};
  return { take,peek:()=>next.done?'':next.value.char,done:()=>next.done,close:()=>iterator.return?.(),
    literal(value){for(const char of value)if(take().toLowerCase()!==char)return false;return true;},
    spaces(required){let count=0;while(!next.done&&/\s/.test(next.value.char)){take();count++;}return !required||count>0;} };
}

module.exports = { createRootPromptText };
