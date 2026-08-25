// Боковая панель-«гость» выезжает за границу своего окна поверх соседнего.
//
// Запрос (2026-08-20): «вкладка… узкая очень, там терминал не видно, он
// выходит за границу… нужно, чтобы он был типа Z-индекс выше и перекрывал,
// допустим, первую колонку». Правило то же, что внутри окна (гость поверх
// центра), перенесённое через его границу: обрезка остаётся только у ЗАКРЫТОЙ
// панели (она прячется сдвигом за правый край), а наверху — окно, в котором
// работают.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const surface = read('SplitPaneSurface.tsx');
const area = read('TerminalArea.tsx');
const frame = read('FloatingTerminalFrame.tsx');

test('флаг открытого гостя объявлен ДО первого использования (шрам TDZ-краша)', () => {
  // «Cannot access surfacesAwake before initialization»: объявление состояния
  // стояло НИЖЕ его использования в useAgentLifecycle. Порядок — контракт.
  assert.ok(
    surface.indexOf('const [surfacesAwake, setSurfacesAwake]')
      < surface.indexOf('enabled: workspaceVisible && surfacesAwake'),
    'surfacesAwake объявляется раньше useAgentLifecycle',
  );
  assert.ok(
    surface.indexOf('const [surfacesAwake, setSurfacesAwake]')
      < surface.indexOf('if (!surfacesAwake) return;'),
    'surfacesAwake объявляется раньше command-state эффекта',
  );
});

test('обрезка окна снимается ровно пока открыт гость — и только по горизонтали', () => {
  assert.match(
    surface,
    /const sideOverlayOpen = historySelected \? sideTerminalOpen : \(isAgentTab && sideHistoryOpen\);/,
    'один вопрос на одно состояние: терминал при переписке-primary, переписка при терминале-primary',
  );
  // За левый край панель выезжать должна (поверх соседа), за верхнюю кромку —
  // нет: сцену терминала композер сдвигает вверх, и без вертикальной обрезки
  // этот верх вылезал над окном. Оба слоя (корень поверхности + контейнер
  // сдвига) переключаются одинаково.
  const clipRule = /\.\.\.\(sideOverlayOpen\s*\n?\s*\? \{ overflowX: 'visible' as const, overflowY: 'clip' as const \}\s*\n?\s*: \{ overflow: 'hidden' as const \}\)/g;
  assert.equal((surface.match(clipRule) || []).length, 2, 'оба слоя обрезки условные, вертикаль остаётся clip');
  assert.ok(!surface.includes("overflow: sideOverlayOpen ? 'visible'"), 'полного снятия обрезки больше нет');
  assert.match(surface, /data-split-pane-surface-overlay=\{sideOverlayOpen \? '1' : '0'\}/);
});

test('боковая переписка не ужимается под узкое окно (тот же слот, та же клавиша)', () => {
  const block = surface.slice(
    surface.indexOf('data-split-pane-side-history'),
    surface.indexOf('zIndex: 130'),
  );
  assert.ok(block.includes('width: historyPanelWidth'), 'ширина панели своя');
  assert.ok(!block.includes("maxWidth: '100%'"), 'клампа под окно больше нет');
});

test('наверху окно, в котором работают', () => {
  // Открытый гость + фокус → выше обычных окон (2), делителей (5) и меток
  // бокового списка (до 10): панель кроет и сам список. Открытый гость без
  // фокуса → ПОД обычные окна: его панель не должна закрывать окно, в котором
  // работают сейчас.
  assert.match(
    area,
    /zIndex: shownInPane\s*\n\s*\? \(paneOverlayOpen \? \(focusedPane \? 12 : 1\) : 2\)\s*\n\s*: \(inPane \? 0 : 1\),/,
  );
  // Обрезка центрального контейнера в разделённом виде снята: она резала
  // панель по границе рабочей области, не пуская её на боковой список.
  const workspaceSrc = read('Workspace.tsx');
  assert.match(workspaceSrc, /splitActiveLayout\s*\n?\s*\? 'flex-1 relative min-w-0'\s*\n?\s*: 'flex-1 relative min-w-0 overflow-hidden'/);
  // Флаг собран тем же правилом, что sideOverlayOpen, и реагирует в момент
  // открытия панели — все четыре UI-подписки в зависимостях memo.
  assert.match(area, /resolveTabTerminalPrimary\(\{ terminalIsPrimaryTabs, newTabPrimarySurface \}, tab\.id\)/);
  for (const dep of ['terminalIsPrimaryTabs', 'newTabPrimarySurface', 'sideTerminalOpenTabs', 'historyPanelOpenTabs']) {
    assert.match(
      area,
      new RegExp(`attachRowH,[^\\]]*${dep}`),
      `memo пересчитывается при смене ${dep}`,
    );
  }
  // useUIStore теперь импортирован (раньше showToast в fork-from-clipboard
  // обращался к нему без импорта — ReferenceError).
  assert.match(area, /import \{ resolveTabTerminalPrimary, useUIStore \} from '\.\.\/\.\.\/store\/useUIStore';/);
});

test('шапка панели наследует невидимость скрытого пространства', () => {
  // Явное visibility:'visible' перебивало бы visibility:hidden обёртки окна
  // чужого пространства — шапка просвечивала бы сквозь скрытое.
  assert.match(frame, /visibility: floating \? undefined : 'hidden',/);
  assert.ok(!frame.includes("visibility: floating ? 'visible'"));
});
