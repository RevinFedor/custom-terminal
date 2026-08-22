'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const overlaySource = fs.readFileSync(
  path.join(root, 'src/renderer/components/UI/ShutdownOverlay.tsx'),
  'utf8',
);

function mainWindowCloseBody() {
  const at = mainSource.indexOf("mainWindow.on('close'");
  assert.ok(at > 0, 'красная кнопка macOS не перехватывается');
  const next = mainSource.indexOf("mainWindow.once('ready-to-show'", at);
  assert.ok(next > at, 'не найдена граница close-обработчика');
  return mainSource.slice(at, next);
}

test('красная кнопка сначала удерживает живое окно и запускает единый quit-path', () => {
  const body = mainWindowCloseBody();
  const doneAt = body.indexOf('if (_gracefulShutdownDone) return');
  const preventAt = body.indexOf('event.preventDefault()');
  const quitAt = body.indexOf('app.quit()');
  assert.ok(doneAt >= 0 && preventAt > doneAt && quitAt > preventAt,
    'первый close обязан оставить renderer живым до before-quit');
  assert.match(body, /if \(_gracefulShutdownInProgress\)/,
    'повторный клик не должен запускать второй shutdown');
});

test('before-quit показывает overlay до медленного proxy drain', () => {
  const at = mainSource.indexOf("app.on('before-quit'");
  const next = mainSource.indexOf("app.on('will-quit'", at);
  const body = mainSource.slice(at, next);
  const overlayAt = body.indexOf("webContents.send('shutdown:overlay'");
  const drainAt = body.indexOf('await proxyGracefulShutdown()');
  assert.ok(overlayAt >= 0 && drainAt > overlayAt,
    'оверлей должен успеть появиться до ожидания сетевых соединений');
  assert.match(body, /SHUTDOWN_OVERLAY_MIN_VISIBLE_MS - elapsed/,
    'одной отправки IPC мало: fast shutdown обязан оставить время на paint');
  assert.match(body, /\[Shutdown:Overlay\] visibleMs=/);
});

test('текст оверлея не врёт про Claude-only и объясняет последующее восстановление', () => {
  assert.match(overlaySource, /активных AI-сессий/);
  assert.match(overlaySource, /восстановятся по очереди/);
  assert.doesNotMatch(overlaySource, /Останавливаю Claude/);
});
