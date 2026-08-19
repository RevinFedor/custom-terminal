'use strict';

// Модуль терминала (node-pty) внутри себя написан так:
//
//   this._socket.on('error', err => { ... if (listeners('error').length < 2) throw err; })
//
// Этот обработчик живёт в фоновом потоке и вызывается через мост между
// потоками. Исключение, выброшенное оттуда наружу, ловить уже некому: оно
// становится аварийным завершением ВСЕГО приложения — без строки в логе.
//
// Слушателей ошибки у нас не было ни одного, поэтому условие «меньше двух»
// выполнялось всегда. Отсюда пять падений 18–19.08 (18:10, 19:28, 20:28,
// 20:39, 03:32 местного времени) — все в момент закрытия приложения, когда
// десятки терминалов умирают разом.
//
// Модуль считает СЛУШАТЕЛЕЙ, а не их полезность. Два — и ветка с выбросом
// физически недостижима.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('the module still throws out of the socket handler below two listeners', () => {
  // Проверка предпосылки на ЖИВОМ модуле: если апстрим уберёт этот выброс,
  // тест обязан об этом сказать, а не молча охранять исчезнувшую проблему.
  const unixTerminal = fs.readFileSync(
    path.join(__dirname, '../../node_modules/node-pty/lib/unixTerminal.js'),
    'utf8',
  );
  assert.match(
    unixTerminal, /listeners\('error'\)\.length < 2/,
    'апстрим больше не бросает ошибку наружу — защиту можно пересмотреть',
  );
});

test('a terminal carries two error listeners from the moment it is created', () => {
  const spawnAt = mainSource.indexOf('ptyProcess = pty.spawn(');
  const dataAt = mainSource.indexOf('ptyProcess.onData(', spawnAt);
  assert.ok(spawnAt > 0 && dataAt > spawnAt);
  const between = mainSource.slice(spawnAt, dataAt);
  const registrations = between.match(/ptyProcess\.on\('error',/g) || [];
  assert.ok(
    registrations.length >= 2,
    'нужно минимум два слушателя ошибки, найдено: ' + registrations.length
    + ' — при меньшем числе модуль выбрасывает ошибку наружу и роняет приложение',
  );
});

test('two listeners on one socket really count as two', () => {
  // Предпосылка ремонта: одна и та же функция, добавленная дважды, считается
  // за два слушателя. Если это перестанет быть так, защита станет мнимой.
  const { EventEmitter } = require('node:events');
  const emitter = new EventEmitter();
  const same = () => {};
  emitter.on('error', same);
  emitter.on('error', same);
  assert.equal(emitter.listeners('error').length, 2);
});

test('routine lifecycle errors stay out of the log, real ones do not', () => {
  const spawnAt = mainSource.indexOf('ptyProcess = pty.spawn(');
  const dataAt = mainSource.indexOf('ptyProcess.onData(', spawnAt);
  const between = mainSource.slice(spawnAt, dataAt);
  assert.match(between, /EIO/, 'смерть дочернего процесса — штатное событие, не шум в логе');
  assert.match(between, /EAGAIN/, 'ошибка готовности на старте — штатное событие');
  assert.match(between, /PTY:SOCKET_ERROR/, 'у настоящей ошибки обязан быть опознаваемый тег');
});
