// Файл, который нельзя разобрать целиком, не должен разбираться вовсе.
//
// Прод 19.08 08:41: приложение закрылось от нехватки памяти. В логе — поток
// полных чтений истории Codex, среди них файл на 717 МБ; память за три минуты
// поднялась с 2.0 до 3.6 ГБ. На диске у пользователя лежат пять файлов больше
// гигабайта (максимум 1369 МБ) — любой из них в разборе убивает процесс.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./codex-data.js');

function tmpJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parse-guard-'));
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('обычный файл разбирается как раньше', async () => {
  const file = tmpJsonl([
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user' } },
  ]);
  const records = await _api.parseJsonlFile(file);
  assert.equal(records.length, 2);
});

test('файл больше потолка не разбирается и не роняет процесс', async () => {
  const file = tmpJsonl([{ type: 'session_meta', payload: { id: 's1' } }]);
  // Подменяем ответ о размере файла, а не пишем гигабайт на диск.
  const realStat = fs.promises.stat;
  fs.promises.stat = async (p, ...rest) => {
    const stat = await realStat.call(fs.promises, p, ...rest);
    if (p === file) {
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: 2600 * 1024 * 1024,
      });
    }
    return stat;
  };
  try {
    const records = await _api.parseJsonlFile(file);
    assert.deepEqual(records, [], 'слишком большой файл обязан вернуть пусто, а не разбираться');
  } finally {
    fs.promises.stat = realStat;
  }
});

test('отказ виден в логе с именем файла и его размером', async () => {
  const file = tmpJsonl([{ type: 'session_meta', payload: { id: 's1' } }]);
  const realStat = fs.promises.stat;
  const realWarn = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(' ')); };
  fs.promises.stat = async (p, ...rest) => {
    const stat = await realStat.call(fs.promises, p, ...rest);
    if (p === file) {
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: 1900 * 1024 * 1024,
      });
    }
    return stat;
  };
  try {
    await _api.parseJsonlFile(file);
  } finally {
    fs.promises.stat = realStat;
    console.warn = realWarn;
  }
  const refused = lines.find((l) => l.includes('[CodexJsonlCache] refused'));
  assert.ok(refused, 'отказ обязан попасть в лог: ' + JSON.stringify(lines));
  assert.ok(refused.includes('sizeMB=1900'), 'в логе обязан быть размер: ' + refused);
  assert.ok(refused.includes(' by='), 'в логе обязан быть заказчик чтения: ' + refused);
});

// --- Картинки внутри записей о сжатии контекста ---
//
// Именно они делают файлы истории гигантскими. Замерено на реальном файле
// пользователя: 1340 МБ, из них 1236 МБ — картинки внутри 64 записей сжатия.
// На экран они не попадали никогда: показ подставляет «[image omitted]».

test('картинка внутри сжатия не попадает в память', async () => {
  const big = 'A'.repeat(300000);
  const file = tmpJsonl([
    { type: 'session_meta', payload: { id: 's1' } },
    {
      type: 'compacted',
      payload: {
        replacement_history: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'важный текст' },
            { type: 'input_image', image_url: 'data:image/png;base64,' + big },
          ],
        }],
      },
    },
  ]);
  const records = await _api.parseJsonlFile(file);
  const compacted = records.find((r) => r.type === 'compacted');
  const content = compacted.payload.replacement_history[0].content;
  assert.equal(content[1].image_url, '[image omitted]', 'картинка обязана быть выброшена');
  assert.equal(content[0].text, 'важный текст', 'текст рядом обязан уцелеть');
});

test('compact fork пишет исходный data URL потоково, а не сохраняет presentation-заглушку', async (t) => {
  const big = 'R'.repeat(300000);
  const dataUrl = 'data:image/png;base64,' + big;
  const source = tmpJsonl([
    { type: 'session_meta', payload: { id: 'raw-fork-source', cwd: '/tmp/project' } },
    {
      type: 'compacted',
      payload: {
        replacement_history: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'важный текст' },
            { type: 'input_image', image_url: dataUrl },
          ],
        }],
      },
    },
  ]);
  const target = path.join(path.dirname(source), 'rollout-fork.jsonl');
  t.after(() => fs.rmSync(path.dirname(source), { recursive: true, force: true }));

  const parsed = await _api.parseJsonlFile(source, { forceFresh: true });
  assert.equal(parsed[1].payload.replacement_history[0].content[1].image_url, '[image omitted]');
  const plan = _api.planCodexForkFromLatestCompact(parsed, 'raw-fork-source');
  assert.equal(plan.success, true);
  await _api.writeCodexJsonlExclusive(target, plan.outputRecords);

  const written = fs.readFileSync(target, 'utf8');
  assert.match(written, /"image_url":"data:image\/png;base64,/);
  assert.equal(written.includes('[image omitted]'), false);
  const output = written.trim().split('\n').map(JSON.parse);
  assert.equal(output[1].payload.replacement_history[0].content[1].image_url, dataUrl);
  assert.equal(Object.hasOwn(output[0], '__line'), false);
  assert.equal(Object.hasOwn(output[0], '__byteOffset'), false);
  assert.equal(Object.hasOwn(output[1], '__line'), false);
  assert.equal(Object.hasOwn(output[1], '__byteOffset'), false);
});

test('compact fork удаляет partial child, если raw image source изменился после чтения', async (t) => {
  const firstUrl = 'data:image/png;base64,' + 'S'.repeat(300000);
  const secondUrl = 'data:image/png;base64,' + 'T'.repeat(300000);
  const source = tmpJsonl([
    { type: 'session_meta', payload: { id: 'raw-fork-cas', cwd: '/tmp/project' } },
    {
      type: 'compacted',
      payload: {
        replacement_history: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: firstUrl }],
        }],
      },
    },
  ]);
  const target = path.join(path.dirname(source), 'rollout-stale-fork.jsonl');
  t.after(() => fs.rmSync(path.dirname(source), { recursive: true, force: true }));

  const parsed = await _api.parseJsonlFile(source, { forceFresh: true });
  const plan = _api.planCodexForkFromLatestCompact(parsed, 'raw-fork-cas');
  assert.equal(plan.success, true);
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(firstUrl, secondUrl));

  await assert.rejects(
    _api.writeCodexJsonlExclusive(target, plan.outputRecords),
    (error) => error?.code === 'codex_compact_raw_image_source_changed',
  );
  assert.equal(fs.existsSync(target), false, 'недописанный fork обязан быть удалён');
});

test('уже повреждённый compact не может породить ещё один resumable fork', async (t) => {
  const source = tmpJsonl([
    { type: 'session_meta', payload: { id: 'poisoned-fork', cwd: '/tmp/project' } },
    {
      type: 'compacted',
      payload: {
        replacement_history: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: '[image omitted]' }],
        }],
      },
    },
  ]);
  const target = path.join(path.dirname(source), 'rollout-poison-child.jsonl');
  t.after(() => fs.rmSync(path.dirname(source), { recursive: true, force: true }));
  const records = await _api.parseJsonlFile(source, { forceFresh: true });
  const plan = _api.planCodexForkFromLatestCompact(records, 'poisoned-fork');
  assert.equal(plan.success, true);
  await assert.rejects(
    _api.writeCodexJsonlExclusive(target, plan.outputRecords),
    (error) => error?.code === 'codex_compact_image_source_unavailable',
  );
  assert.equal(fs.existsSync(target), false);
});

test('картинка в ОБЫЧНОМ сообщении сохраняется целиком', async () => {
  // Она нужна для повтора запроса с изображением — резать её нельзя.
  const big = 'B'.repeat(300000);
  const dataUrl = 'data:image/png;base64,' + big;
  const file = tmpJsonl([
    { type: 'session_meta', payload: { id: 's1' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: dataUrl }],
      },
    },
  ]);
  const records = await _api.parseJsonlFile(file);
  const item = records.find((r) => r.type === 'response_item');
  assert.equal(item.payload.content[0].image_url, dataUrl, 'обычная картинка обязана уцелеть');
});

test('обрезка кратно снижает вес разобранного файла', async () => {
  const big = 'C'.repeat(1024 * 1024);
  const rows = [{ type: 'session_meta', payload: { id: 's1' } }];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      type: 'compacted',
      payload: {
        replacement_history: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'запись ' + i },
            { type: 'input_image', image_url: 'data:image/png;base64,' + big },
          ],
        }],
      },
    });
  }
  const file = tmpJsonl(rows);
  const onDisk = fs.statSync(file).size;
  const records = await _api.parseJsonlFile(file);
  const inMemory = JSON.stringify(records).length;
  assert.ok(onDisk > 8 * 1024 * 1024, 'на диске обязан быть многомегабайтный файл');
  assert.ok(
    inMemory < onDisk / 10,
    'после обрезки разобранное обязано весить кратно меньше: на диске '
      + Math.round(onDisk / 1048576) + ' МБ, в памяти ' + Math.round(inMemory / 1024) + ' КБ',
  );
});
