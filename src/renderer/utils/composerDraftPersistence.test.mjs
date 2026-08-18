import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_DRAFT_STATE_LIMIT,
  buildComposerDraftMemory,
  readComposerDraftMemory,
  splitComposerDraftMemory,
} from './composerDraftPersistence.mjs';

test('composer draft persistence round-trips text, image refs, and hidden chip bodies together', () => {
  const memory = buildComposerDraftMemory({
    drafts: { a: 'before [Image #1] [Pasted Content 5 chars] after' },
    images: { a: [{ id: 1, path: '/tmp/image.png', availability: 'available', assetId: 'asset.png' }] },
    chips: { a: [{ id: 'paste-1', kind: 'paste', text: 'hello', label: 'Paste' }] },
    updatedAtByTab: { a: 42 },
  });
  assert.deepEqual(splitComposerDraftMemory(memory), {
    drafts: { a: 'before [Image #1] [Pasted Content 5 chars] after' },
    images: { a: [{ id: 1, path: '/tmp/image.png', assetId: 'asset.png', availability: 'available' }] },
    chips: { a: [{ id: 'paste-1', kind: 'paste', text: 'hello', label: 'Paste' }] },
    updatedAtByTab: { a: 42 },
  });
});

test('composer draft persistence rejects corrupt sidecars instead of reviving broken markers', () => {
  assert.deepEqual(readComposerDraftMemory({
    good: { text: 'safe', images: [{ id: 0, path: '' }], chips: [{ id: '', kind: 'paste', text: 'x' }] },
    empty: { text: '', images: [], chips: [] },
    bad: null,
  }), {
    good: { text: 'safe', images: [], chips: [], updatedAt: 0 },
  });
});

test('composer draft persistence caps old tab records but always keeps the newest draft', () => {
  const source = {};
  for (let index = 0; index < COMPOSER_DRAFT_STATE_LIMIT + 3; index += 1) {
    source[`tab-${index}`] = {
      text: `draft-${index}`,
      images: [],
      chips: [],
      updatedAt: index + 1,
    };
  }
  const memory = readComposerDraftMemory(source);
  assert.equal(Object.keys(memory).length, COMPOSER_DRAFT_STATE_LIMIT);
  assert.equal(memory['tab-0'], undefined);
  assert.equal(memory[`tab-${COMPOSER_DRAFT_STATE_LIMIT + 2}`].text, `draft-${COMPOSER_DRAFT_STATE_LIMIT + 2}`);
});

// ── Черновик сохраняется, ПОКА печатают ───────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiStore = fs.readFileSync(path.join(here, '..', 'store', 'useUIStore.ts'), 'utf8');
const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');

test('запись на диск следует за ИЗМЕНЕНИЕМ, а не за списком писателей', () => {
  // Раньше на диск писали только «события»: отправка, уход со вкладки, закрытие
  // окна. Пока человек печатал, длинный промпт жил только в памяти. Теперь
  // сохранение подписано на сам факт изменения — подписка, а не вызов в каждом
  // из пяти мутаторов: шестой, который появится завтра, получит его бесплатно.
  assert.match(uiStore, /useUIStore\.subscribe\(\(state\) => \{/);
  assert.match(uiStore, /state\.scheduleHistoryComposerDraftSave\(\);/);
  // Сравнение по ССЫЛКАМ: мутаторы пересобирают объекты, поэтому неравенство
  // ссылок и есть «поменялось» — без обхода содержимого на каждую букву.
  assert.match(uiStore, /state\.historyPromptDrafts === lastDraftSnapshot\.drafts/);
  assert.match(uiStore, /state\.historyPromptDraftImages === lastDraftSnapshot\.images/);
  assert.match(uiStore, /state\.historyPromptDraftChips === lastDraftSnapshot\.chips/);
});

test('запись отложена, но закрытие окна её не ждёт', () => {
  // Задержка нужна, потому что промпты бывают в десятки килобайт, а запись
  // синхронно зеркалится в базу. На закрытии окна ждать эти полсекунды уже
  // некому — там запись немедленная.
  assert.match(uiStore, /COMPOSER_DRAFT_AUTOSAVE_MS = 500/);
  assert.match(app, /flushHistoryComposerDrafts\(\);/);
  // Явный flush обязан снять отложенный: иначе таймер перепишет уже записанное.
  const flushAt = uiStore.indexOf('flushHistoryComposerDrafts: () => {');
  const flush = uiStore.slice(
    flushAt,
    uiStore.indexOf('scheduleHistoryComposerDraftSave: () => {', flushAt),
  );
  assert.match(flush, /clearTimeout\(composerDraftAutosaveTimer\)/);
});
