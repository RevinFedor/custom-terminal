import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controlBarBusyTarget,
  isControlBarBusyTarget,
  isControlBarBusyBlocked,
} from './controlBarBusyTarget.mjs';

test('кружок садится на ту кнопку, которую меняют', () => {
  assert.equal(controlBarBusyTarget('claude-model:opus'), 'model');
  assert.equal(controlBarBusyTarget('codex-effort:high'), 'effort');
  assert.equal(controlBarBusyTarget('provider:zen'), 'provider');
  assert.equal(controlBarBusyTarget('claude-think:on'), 'think');
  assert.equal(controlBarBusyTarget('codex-fast'), 'fast');
});

test('пара «модель + усилие» показывает кружок на МОДЕЛИ', () => {
  // Это один жест, начатый на строке модели: пользователь навёл на модель и
  // выбрал усилие рядом. Показать кружок на усилии значило бы отметить кнопку,
  // которую он не трогал.
  assert.equal(controlBarBusyTarget('provider-model:anthropic:opus'), 'model');
  assert.equal(controlBarBusyTarget('claude-model-effort:opus:max'), 'model');
});

test('действия сессии узнаются отдельно от настроек', () => {
  assert.equal(controlBarBusyTarget('session:start'), 'session');
  assert.equal(controlBarBusyTarget('continue-session'), 'session');
  assert.equal(controlBarBusyTarget('stop-process'), 'session');
});

test('незнакомая причина не назначает кружок никому', () => {
  // Лучше «всё занято и ничего не крутится», чем кружок на случайной кнопке:
  // он бы соврал про то, что именно применяется.
  assert.equal(controlBarBusyTarget('paste'), null);
  assert.equal(controlBarBusyTarget(''), null);
  assert.equal(controlBarBusyTarget(null), null);
  assert.equal(controlBarBusyTarget(undefined), null);
});

test('кружок ровно один: только у своей кнопки', () => {
  const args = { busy: true, reason: 'claude-model:opus' };
  assert.equal(isControlBarBusyTarget({ ...args, control: 'model' }), true);
  assert.equal(isControlBarBusyTarget({ ...args, control: 'effort' }), false);
  assert.equal(isControlBarBusyTarget({ ...args, control: 'provider' }), false);
});

test('пока не занято — не крутится ничего', () => {
  assert.equal(
    isControlBarBusyTarget({ busy: false, reason: 'claude-model:opus', control: 'model' }),
    false,
  );
});

test('соседи блокируются, а занятая кнопка остаётся кликабельной', () => {
  // В этом вся разница между «ждёт» и «недоступно»: по крутящейся кнопке можно
  // кликнуть, чтобы отменить, поэтому она НЕ disabled.
  const args = { busy: true, reason: 'claude-model:opus' };
  assert.equal(isControlBarBusyBlocked({ ...args, control: 'model' }), false);
  assert.equal(isControlBarBusyBlocked({ ...args, control: 'effort' }), true);
  assert.equal(isControlBarBusyBlocked({ ...args, control: 'think' }), true);
});

test('при незнакомой причине блокируется всё', () => {
  // Неизвестно, что именно пишется, значит отменять нечему и разрешать нечего.
  const args = { busy: true, reason: 'paste' };
  assert.equal(isControlBarBusyBlocked({ ...args, control: 'model' }), true);
  assert.equal(isControlBarBusyBlocked({ ...args, control: 'effort' }), true);
  assert.equal(isControlBarBusyTarget({ ...args, control: 'model' }), false);
});

test('свободная панель ничего не блокирует', () => {
  assert.equal(
    isControlBarBusyBlocked({ busy: false, reason: null, control: 'model' }),
    false,
  );
});

test('регистр и пробелы в причине не мешают', () => {
  assert.equal(controlBarBusyTarget('  Claude-Model:Opus '), 'model');
});
