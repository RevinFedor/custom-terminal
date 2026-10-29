'use strict';

// Reproduce only the CURRENT local-prompt compatibility slice and its exact
// image-grammar dependency. Full source bytes are read for pins, but only the
// named <=24KiB declarations are parsed. This is not an application build or
// a whole HistoryPanel TypeScript program. Other frozen modules stay pinned
// to their historical inputs; regenerating them is outside this slice.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const COMPAT = 'src/main/history-root-engine/main/history-primary-compat';
const PANEL = 'src/renderer/components/Workspace/HistoryPanel.tsx';
const HANDOFFS = 'src/renderer/utils/historyPromptHandoffs.ts';
const IMAGE = 'src/shared/prompt-image-attachments.mjs';
const WEB = 'src/shared/prompt-web-images.cjs';
const LOCAL = 'src/renderer/utils/primaryLocalCompat.ts';
const header = '// GENERATED frozen Current pure compatibility. See manifest.json.\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const panelNames = ['LOCAL_PROMPT_PREFIX', 'LOCAL_REWIND_PREFIX', 'LOCAL_COMPACT_ERROR_PREFIX',
  'LOCAL_PROMPT_FAILURE_TTL_MS', 'normalizeHistoryPromptText', 'normalizeHistoryPromptIdentityText',
  'isLocalPromptEntry', 'isLocalRewindEntry', 'isLocalCompactErrorEntry', 'findServerPromptEntry',
  'serverHasPromptEntry', 'mergeServerAndLocalEntries', 'entryClockMs', 'shouldCarryAfterRewindTarget',
  'buildRewindPreviewEntries', 'entryMatchesSuppressedPrompt', 'filterSuppressedPromptEntries'];
const handoffNames = ['HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS', 'historyPromptFailureHasRecoveryOwner',
  'ORCHESTRATION_COMPLETION_HANDOFF_PREFIX', 'ORCHESTRATION_COMPLETION_SOURCE_PREFIX',
  'legacyOrchestrationCompletionMatchesCanonicalEntry'];

function selectedDeclaration(source, name) {
  const marker = new RegExp('^(?:export\\s+)?(?:const|function)\\s+' + name + '\\b', 'gm');
  const first = marker.exec(source);
  assert(first && !marker.exec(source), 'one actual source declaration: ' + name);
  const rest = source.slice(first.index + first[0].length);
  const next = /^(?:export\s+)?(?:const|let|function|async function|interface|type|class)\s+/m.exec(rest);
  const selected = source.slice(first.index, next ? first.index + first[0].length + next.index : source.length).trimEnd();
  assert(Buffer.byteLength(selected) <= 24 * 1024, 'bounded declaration: ' + name);
  return selected;
}
function compileModule(source) {
  const exported = [...source.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map(match => match[1]);
  const lists = [...source.matchAll(/^export \{ ([^}]+) \};$/gm)].flatMap(match => match[1].split(',').map(x => x.trim()));
  const result = source.replace(/^import webImages from '\.\/prompt-web-images\.cjs';$/m,
    "const webImages = require('./prompt-web-images.cjs.cjs');")
    .replace(/^export \{ [^}]+ \};\n/gm, '')
    .replace(/^export (?=(?:async )?function )/gm, '');
  assert(!/^\s*(?:import|export)\b/m.test(result), 'known static module grammar');
  return header + "'use strict';\n" + result.trimEnd() + '\nmodule.exports = { '
    + [...new Set([...lists, ...exported])].join(', ') + ' };\n';
}
function generate(root = ROOT) {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const panel = read(PANEL), handoffs = read(HANDOFFS);
  const panelSelected = panelNames.map(name => selectedDeclaration(panel, name)).join('\n\n');
  const handoffSelected = handoffNames.map(name => selectedDeclaration(handoffs, name)).join('\n\n');
  const imports = [
    "const { buildHistoryLivePresentation } = require('./historyLiveProjection.mjs.cjs');",
    "const { projectNativeRewindPreview } = require('./historyRewindPreviewOwner.ts.cjs');",
    "const { normalizePromptImageIdentity } = require('./promptImageAttachments.mjs.cjs');",
    "const { matchesHistoryPromptExactProof, matchesHistoryPromptAdoption, matchesHistoryPromptSuppression } = require('./historyPromptPresentation.mjs.cjs');",
    '// Diagnostic output belongs to the host; the selected pure predicates stay verbatim.',
    'const historyDiag = (_message) => {};',
  ].join('\n');
  const virtual = imports + '\n\n' + handoffSelected + '\n\n' + panelSelected + '\n';
  const generated = header + "'use strict';\n" + stripTypeScriptTypes(virtual.replace(/^export /gm, ''), { mode: 'strip' })
    + '\nmodule.exports = { HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS, historyPromptFailureHasRecoveryOwner,\n'
    + '  legacyOrchestrationCompletionMatchesCanonicalEntry, isLocalPromptEntry, findServerPromptEntry,\n'
    + '  serverHasPromptEntry, mergeServerAndLocalEntries, buildRewindPreviewEntries, filterSuppressedPromptEntries };\n';
  const image = read(IMAGE), web = read(WEB);
  const outputs = new Map([
    [COMPAT + '/' + LOCAL + '.cjs', generated],
    [COMPAT + '/' + IMAGE + '.cjs', compileModule(image)],
    [COMPAT + '/' + WEB + '.cjs', header + web],
  ]);
  const manifest = JSON.parse(read(COMPAT + '/manifest.json'));
  const replacePin = pin => {
    manifest.pins = manifest.pins.filter(old => !(old.path === pin.path && old.kind === pin.kind));
    manifest.pins.push(pin);
  };
  // The former separate suppression extraction is now in the same exact
  // composed module, eliminating misleading stale full-Panel pins.
  manifest.pins = manifest.pins.filter(pin => pin.path !== PANEL && pin.path !== HANDOFFS);
  replacePin({ path: PANEL, kind: 'extracted-declarations', names: panelNames,
    currentSHA256: sha(panel), selectedSHA256: sha(panelSelected) });
  replacePin({ path: HANDOFFS, kind: 'extracted-declarations', names: handoffNames,
    currentSHA256: sha(handoffs), selectedSHA256: sha(handoffSelected) });
  replacePin({ path: LOCAL, kind: 'composed-pure-extract', currentSHA256: sha(virtual),
    output: LOCAL + '.cjs', outputSHA256: sha(generated),
    dependencies: ['src/renderer/utils/historyLiveProjection.mjs', 'src/renderer/utils/historyRewindPreviewOwner.ts',
      'src/renderer/utils/promptImageAttachments.mjs', 'src/renderer/utils/historyPromptPresentation.mjs'] });
  replacePin({ path: IMAGE, kind: 'whole-static-module', currentSHA256: sha(image),
    output: IMAGE + '.cjs', outputSHA256: sha(outputs.get(COMPAT + '/' + IMAGE + '.cjs')), dependencies: [WEB] });
  replacePin({ path: WEB, kind: 'whole-static-module', currentSHA256: sha(web),
    output: WEB + '.cjs', outputSHA256: sha(outputs.get(COMPAT + '/' + WEB + '.cjs')), dependencies: [] });
  manifest.localCompatibilityGenerator = { path: 'scripts/generate-history-primary-local-compat.cjs',
    sourceSHA256: sha(fs.readFileSync(__filename)),
    parser: 'node:module.stripTypeScriptTypes mode=strip; selected declarations only',
    scope: 'CURRENT local prompt adoption, recovery retention and image identity grammar; other frozen modules unchanged' };
  outputs.set(COMPAT + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return outputs;
}
function check(root = ROOT) {
  for (const [file, contents] of generate(root)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), contents, file);
}
if (require.main === module) {
  assert(process.argv.length <= 3 && ['--write', '--check', undefined].includes(process.argv[2]), 'use --check or --write');
  if (process.argv[2] === '--write') for (const [file, contents] of generate()) fs.writeFileSync(path.join(ROOT, file), contents);
  else check();
  process.stdout.write('CURRENT local compatibility ' + (process.argv[2] === '--write' ? 'generated' : 'verified') + '\n');
}
module.exports = { generate, check, selectedDeclaration, panelNames, handoffNames };
