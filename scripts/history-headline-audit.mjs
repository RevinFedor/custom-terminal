#!/usr/bin/env node
/**
 * History headline audit — прогоняет ТЕКУЩУЮ грамматику заголовков по свежим
 * реальным транскриптам (Claude JSONL + Codex rollouts) и ловит строки, где
 * заголовок вышел кривым: пустой объект (карточка падает на печать сырой
 * команды серым), неразрешённый `${…}`, заглушка `(patch)`, флаг/кавычка/
 * переменная вместо имени файла, транспортное имя MCP и т.п.
 *
 * Зачем: каждая итерация визуала чинила заголовок по ОДНОМУ скриншоту.
 * Стенд закрывает класс целиком — после любой правки грамматики один прогон
 * по последним сессиям показывает, что сломалось и что осталось.
 *
 *   node scripts/history-headline-audit.mjs                # последние 12+12
 *   node scripts/history-headline-audit.mjs --claude 30 --codex 30
 *   node scripts/history-headline-audit.mjs --samples 10   # больше примеров
 *   node scripts/history-headline-audit.mjs --rule empty-subject-fallback
 *
 * Только чтение: транскрипты не изменяются, приложение не нужно.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

const grammar = await import(path.join(repoRoot, 'src/shared/history-action-grammar.mjs'));
const { classifyHistoryAction, historyActionHeadline } = grammar;

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argNum = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const argStr = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? String(argv[i + 1] || '') : '';
};
const CLAUDE_N = argNum('claude', 12);
const CODEX_N = argNum('codex', 12);
const SAMPLES = argNum('samples', 5);
const ONLY_RULE = argStr('rule');

// ── Сбор действий ──────────────────────────────────────────────────────────

/** Последние N файлов по mtime из списка. */
const newest = (files, n) => files
  .map((filePath) => ({ filePath, mtime: fs.statSync(filePath).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, n)
  .map((x) => x.filePath);

function listClaudeTranscripts(n) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const dir of fs.readdirSync(root)) {
    const abs = path.join(root, dir);
    let stat; try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.jsonl')) files.push(path.join(abs, name));
    }
  }
  return newest(files, n);
}

function listCodexRollouts(n) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      let stat; try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.isDirectory()) walk(abs);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(abs);
    }
  };
  walk(root);
  return newest(files, n);
}

/**
 * Claude: tool_use-блоки достаются напрямую из записей — ровно те же
 * name+input, что видит парсер перед классификацией. Стримом, потому что
 * транскрипты бывают в сотни мегабайт.
 */
async function collectClaudeActions(filePath, sink) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"tool_use"')) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || !block.name) continue;
      sink({ provider: 'claude', file: filePath, toolName: String(block.name), args: block.input || {} });
    }
  }
}

/**
 * Codex: через НАСТОЯЩИЙ парсер main-процесса (вложенные exec, apply_patch,
 * события применения патча) — аудитим то, что реально попадёт в ленту, а не
 * пересобранную копию логики.
 */
async function collectCodexActions(filePath, sink) {
  const codexData = require(path.join(repoRoot, 'src/main/ipc/codex-data.js'));
  const api = codexData._api;
  const sessionId = (filePath.match(/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/) || [])[1]
    || path.basename(filePath, '.jsonl');
  const records = await api.parseJsonlFile(filePath);
  const entries = api.buildCodexFullHistory(records, sessionId);
  for (const entry of entries) {
    for (const action of (entry.actions || [])) {
      const raw = action?.rawTool;
      if (!raw) continue;
      sink({
        provider: 'codex',
        file: filePath,
        toolName: String(raw.toolName || ''),
        args: raw.args || {},
        stamped: {
          family: raw.family, bashWord: raw.bashWord, bashDetail: raw.bashDetail,
          mcpServer: raw.mcpServer, mcpMethod: raw.mcpMethod,
        },
      });
    }
  }
}

// ── Проверки ───────────────────────────────────────────────────────────────
//
// BAD  — заголовок точно сломан: пользователь увидит мусор/пустоту/ложь.
// WARN — подозрительно: стоит посмотреть глазами, но может быть законно.

const RULES = {
  'headline-throws':        { severity: 'BAD', note: 'грамматика бросила исключение' },
  'empty-verb':             { severity: 'BAD', note: 'пустой глагол' },
  'unresolved-template':    { severity: 'BAD', note: '`${…}` — исходник значения вместо значения' },
  'patch-placeholder':      { severity: 'BAD', note: 'заглушка (patch) вместо файлов' },
  'newline-in-subject':     { severity: 'BAD', note: 'перенос строки внутри объекта' },
  'mcp-transport-verb':     { severity: 'BAD', note: 'транспортное имя mcp__ в заголовке' },
  'flag-as-subject':        { severity: 'BAD', note: 'флаг (-x) вместо имени файла' },
  'quote-as-subject':       { severity: 'BAD', note: 'кавычка в начале объекта' },
  'var-as-subject':         { severity: 'BAD', note: 'неразвёрнутая $ПЕРЕМЕННАЯ вместо пути' },
  'separator-in-subject':   { severity: 'BAD', note: 'разделитель конвейера в имени файла' },
  'read-no-path':           { severity: 'BAD', note: 'Read без пути' },
  'edit-no-path':           { severity: 'BAD', note: 'Edit без пути' },
  'junk-run-subject':       { severity: 'BAD', note: 'мусор в заголовке запуска (=, кавычки, $)' },
  // Historical rule id stays CLI-compatible. Since 17.08 the package no
  // longer falls back to a raw command when History injected a semantic
  // headline; an empty subject now means a verb-only header that is worth
  // reviewing, not a pipeline leak.
  'empty-subject-fallback': { severity: 'WARN', note: 'пустой объект → заголовок показывает только смысловой глагол' },
  'overlong-subject':       { severity: 'WARN', note: 'объект длиннее 160 символов' },
  'space-no-path-subject':  { severity: 'WARN', note: 'объект с пробелами, не похожий на путь' },
};

function auditOne({ toolName, args, stamped }) {
  let cls;
  let headline;
  try {
    cls = stamped?.family
      ? { family: stamped.family, bashWord: stamped.bashWord, bashDetail: stamped.bashDetail, mcpServer: stamped.mcpServer, mcpMethod: stamped.mcpMethod }
      : classifyHistoryAction({ toolName, args });
    headline = historyActionHeadline({ toolName, args, ...cls });
  } catch (error) {
    return { issues: ['headline-throws'], headline: { verb: '', subject: String(error?.message || error) }, family: '?' };
  }
  const issues = [];
  const subject = String(headline.subject || '');
  const verb = String(headline.verb || '');
  const family = String(cls.family || '');
  const command = typeof args?.command === 'string' ? args.command : '';

  if (!verb) issues.push('empty-verb');
  if (subject.includes('\n')) issues.push('newline-in-subject');
  // `${` в ПОИСКОВОМ паттерне — искомый текст, а не неразрешённый шаблон;
  // нарушение — только когда `${…}` изображает имя файла или значение.
  if (subject.includes('${') && family !== 'search') issues.push('unresolved-template');
  if (subject === '(patch)') issues.push('patch-placeholder');
  if (subject.length > 160) issues.push('overlong-subject');
  if (family === 'mcp' && (verb.startsWith('mcp__') || verb.includes('__'))) issues.push('mcp-transport-verb');

  if (toolName === 'Read' && !subject) issues.push('read-no-path');
  if (family === 'edit' && toolName !== 'Patch' && !subject) issues.push('edit-no-path');

  if (toolName === 'Bash') {
    if (family === 'read' && subject) {
      if (/^-/.test(subject)) issues.push('flag-as-subject');
      if (/^['"`]/.test(subject)) issues.push('quote-as-subject');
      if (/^\$/.test(subject)) issues.push('var-as-subject');
      if (/[|;]/.test(subject)) issues.push('separator-in-subject');
      if (/\s/.test(subject) && !subject.includes('/')) issues.push('space-no-path-subject');
    }
    if (family === 'run' && subject && /[='"`$]/.test(subject)) issues.push('junk-run-subject');
    // Пустой объект у read/search/run — карточка упадёт на серую сырую команду.
    if (!subject && command.trim() && (family === 'read' || family === 'search' || family === 'run')) {
      issues.push('empty-subject-fallback');
    }
  }
  return { issues, headline, family };
}

// ── Прогон ─────────────────────────────────────────────────────────────────

const byRule = new Map(); // rule → { count, samples: Map<signature, sample> }
let total = 0;
const perProvider = { claude: 0, codex: 0 };

const record = (rule, sample) => {
  let bucket = byRule.get(rule);
  if (!bucket) { bucket = { count: 0, samples: new Map() }; byRule.set(rule, bucket); }
  bucket.count += 1;
  // Дедуп примеров по форме команды/объекта, чтобы один паттерн не съел лимит.
  const signature = (sample.command || sample.subject || sample.toolName).slice(0, 80);
  if (!bucket.samples.has(signature) && bucket.samples.size < SAMPLES) {
    bucket.samples.set(signature, sample);
  }
};

const sink = (action) => {
  total += 1;
  perProvider[action.provider] += 1;
  const { issues, headline, family } = auditOne(action);
  for (const rule of issues) {
    if (ONLY_RULE && rule !== ONLY_RULE) continue;
    record(rule, {
      provider: action.provider,
      file: path.basename(action.file),
      toolName: action.toolName,
      family,
      verb: headline.verb,
      subject: headline.subject,
      detail: headline.detail,
      command: typeof action.args?.command === 'string' ? action.args.command : '',
    });
  }
};

const claudeFiles = listClaudeTranscripts(CLAUDE_N);
const codexFiles = listCodexRollouts(CODEX_N);
console.log(`Транскрипты: Claude ${claudeFiles.length}, Codex ${codexFiles.length}\n`);

for (const file of claudeFiles) {
  try { await collectClaudeActions(file, sink); }
  catch (error) { console.error('  ! claude skip', path.basename(file), String(error?.message || error)); }
}
for (const file of codexFiles) {
  try { await collectCodexActions(file, sink); }
  catch (error) { console.error('  ! codex skip', path.basename(file), String(error?.message || error)); }
}

// ── Отчёт ──────────────────────────────────────────────────────────────────

const short = (text, n = 110) => {
  const flat = String(text || '').replace(/\n/g, '⏎');
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

console.log(`Действий проверено: ${total} (claude ${perProvider.claude}, codex ${perProvider.codex})\n`);

const order = Object.keys(RULES);
const found = order.filter((rule) => byRule.has(rule));
if (found.length === 0) {
  console.log('✔ Ни одного нарушения не найдено.');
  process.exit(0);
}

let badTotal = 0;
for (const rule of found) {
  const { severity, note } = RULES[rule];
  const bucket = byRule.get(rule);
  if (severity === 'BAD') badTotal += bucket.count;
  console.log(`[${severity}] ${rule} ×${bucket.count} — ${note}`);
  for (const sample of bucket.samples.values()) {
    console.log(`    ${sample.provider}/${sample.toolName}(${sample.family}) → verb=«${sample.verb}» subject=«${short(sample.subject, 70)}»`);
    if (sample.command) console.log(`      cmd: ${short(sample.command)}`);
  }
  console.log('');
}

console.log(badTotal > 0
  ? `✘ BAD-нарушений: ${badTotal}. Заголовки этих строк пользователь увидит сломанными.`
  : '✔ BAD-нарушений нет; остались только WARN — посмотреть глазами.');
process.exit(badTotal > 0 ? 1 : 0);
