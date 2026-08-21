import test from 'node:test';
import assert from 'node:assert/strict';

import {
  historyDisplayUnitsBaselineCount,
  peekHistoryDisplayUnitsBaseline,
  rememberHistoryDisplayUnitsBaseline,
} from './historyDisplayUnitsBaseline.mjs';

const baseline = (ownerKey, n = 1) => ({
  ownerKey,
  entries: Array.from({ length: n }, (_, i) => ({ uuid: ownerKey + '-' + i })),
  options: { enabled: true, threshold: 2, expandedKeys: new Set() },
  units: [{ kind: 'entry' }],
});

test('базовая строка переживает «размонтирование»: положили — забрали тем же ключом', () => {
  const b = baseline('owner-a');
  rememberHistoryDisplayUnitsBaseline(b);
  assert.equal(peekHistoryDisplayUnitsBaseline('owner-a'), b);
  assert.equal(peekHistoryDisplayUnitsBaseline('owner-b'), null);
});

test('без ключа или без массивов ничего не хранится', () => {
  rememberHistoryDisplayUnitsBaseline(null);
  rememberHistoryDisplayUnitsBaseline({ ownerKey: '', entries: [], units: [] });
  rememberHistoryDisplayUnitsBaseline({ ownerKey: 'x', entries: 'no', units: [] });
  assert.equal(peekHistoryDisplayUnitsBaseline('x'), null);
});

test('память ограничена: старейший владелец вытесняется, недавно читанный — нет', () => {
  for (let i = 0; i < 16; i += 1) rememberHistoryDisplayUnitsBaseline(baseline('evict-' + i));
  // Прочитали самого старого — он стал самым свежим.
  assert.ok(peekHistoryDisplayUnitsBaseline('evict-0'));
  rememberHistoryDisplayUnitsBaseline(baseline('evict-new'));
  // Вытеснился evict-1 (старейший), а не только что читанный evict-0.
  assert.equal(peekHistoryDisplayUnitsBaseline('evict-1'), null);
  assert.ok(peekHistoryDisplayUnitsBaseline('evict-0'));
  assert.ok(historyDisplayUnitsBaselineCount() <= 16);
});

test('повторная запись того же владельца не плодит записей', () => {
  rememberHistoryDisplayUnitsBaseline(baseline('same'));
  const afterFirst = historyDisplayUnitsBaselineCount();
  const second = baseline('same');
  rememberHistoryDisplayUnitsBaseline(second);
  assert.equal(historyDisplayUnitsBaselineCount(), afterFirst);
  assert.equal(peekHistoryDisplayUnitsBaseline('same'), second, 'выигрывает свежая запись');
});

// ── Сквозная регрессия на сам симптом: пробуждение после стрима ────────────
// Панель уснула после доклейки → проснулась с тем же (после-доклеечным)
// массивом записей. Раньше: peek мимо (кэш знал только до-доклеечный массив),
// база умерла вместе с панелью → полный проход. Теперь: результат доклейки
// запомнен и по массиву, и по сессии — пробуждение отвечает из кэша.
import {
  buildHistoryDisplayUnitsAppended,
  buildHistoryDisplayUnitsCached,
  peekHistoryDisplayUnitsCached,
  rememberHistoryDisplayUnitsCached,
} from './historyDisplayUnits.mjs';

test('пробуждение после стрима: доклеенная карта находится в кэше, полный проход не нужен', () => {
  let seq = 0;
  const row = (role, props = {}) => ({
    uuid: 'u-' + (seq += 1), role, timestamp: '', content: 'x', sessionId: 's', ...props,
  });
  const user = () => row('user', { content: 'go' });
  const options = { enabled: true, threshold: 2, expandedKeys: new Set() };

  // Визит 1: полная сборка, затем живая доклейка (новый массив, общий префикс).
  // Префикс ≥8 строк: короче доклейка честно отказывается — полный проход дешевле.
  const first = [];
  for (let i = 0; i < 6; i += 1) { first.push(user(), row('assistant')); }
  const firstUnits = buildHistoryDisplayUnitsCached(first, options);
  const appendedEntries = [...first, user(), row('assistant')];
  const appended = buildHistoryDisplayUnitsAppended(first, firstUnits, appendedEntries, options, options);
  assert.ok(appended, 'доклейка применима: общий префикс с жёсткой границей');
  rememberHistoryDisplayUnitsCached(appendedEntries, options, appended.units);

  // Сон панели. Визит 2: snapshot-кэш отдаёт ТОТ ЖЕ после-доклеечный массив.
  assert.equal(
    peekHistoryDisplayUnitsCached(appendedEntries, options),
    appended.units,
    'карта после доклейки обязана находиться по массиву — без полного прохода',
  );

  // И база по сессии тоже пережила сон — доклейка следующего стрима начнёт
  // не с нуля.
  rememberHistoryDisplayUnitsBaseline({
    ownerKey: 'owner-stream', entries: appendedEntries, options, units: appended.units,
  });
  const revived = peekHistoryDisplayUnitsBaseline('owner-stream');
  assert.equal(revived.entries, appendedEntries);
  assert.equal(revived.units, appended.units);
});
