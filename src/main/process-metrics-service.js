'use strict';

/**
 * Связывает сбор метрик с интерфейсом: держит предыдущий снимок (без него
 * нельзя посчитать текущую загрузку процессора) и отдаёт готовую раскладку.
 *
 * Замер идёт только пока панель открыта: подписчик появился — начали, ушёл
 * последний — остановились. Постоянный фоновый опрос ради закрытой панели был
 * бы тратой без адресата.
 */

const { captureNativeSnapshot, computeCpuPercent, loadNative } = require('./process-metrics-source');
const { groupProcessMetrics } = require('./process-metrics-grouping');

const DEFAULT_INTERVAL_MS = 2000;

function createProcessMetricsService({
  capture = captureNativeSnapshot,
  computeCpu = computeCpuPercent,
  group = groupProcessMetrics,
  collectContext,
  onUpdate,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = console,
} = {}) {
  if (typeof collectContext !== 'function') {
    throw new TypeError('collectContext must be a function');
  }

  let previousSnapshot = null;
  let timer = null;
  const subscribers = new Set();

  function measure() {
    const snapshot = capture();
    if (!snapshot || !snapshot.ok) {
      return {
        ok: false,
        reason: (snapshot && snapshot.reason) || 'capture-failed',
      };
    }

    // Первый замер не может дать загрузку процессора: прирост считать не с чем.
    // Возвращаем null, а не ноль — «неизвестно» и «простаивает» это разные
    // утверждения, и рисовать их одинаково нельзя.
    const cpuByPid = previousSnapshot ? computeCpu(previousSnapshot, snapshot) : null;
    previousSnapshot = snapshot;

    const context = collectContext() || {};
    const grouped = group({
      snapshot,
      cpuByPid,
      tabs: context.tabs || [],
      appPids: context.appPids || [],
      projectId: context.projectId || null,
    });

    return { ok: true, ...grouped };
  }

  /**
   * Замер, который не бросает наружу. Сбой сбора — это отсутствие цифр, а не
   * причина уронить того, кто их запросил: иначе одна ошибка внутри ломает
   * открытие панели целиком.
   */
  function measureSafely() {
    try {
      return measure();
    } catch (error) {
      log.warn('[ProcessMetrics] measure failed: ' + (error && error.message));
      return { ok: false, reason: 'measure-threw' };
    }
  }

  function tick() {
    const payload = measureSafely();
    if (typeof onUpdate === 'function') onUpdate(payload);
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
    // Снимок протухает, пока никто не смотрит: сравнивать свежий замер с
    // получасовой давности бессмысленно — «загрузка» размажется по интервалу
    // простоя и покажет почти ноль для активного процесса.
    previousSnapshot = null;
  }

  return {
    /** Разовый замер — для первого показа панели, без ожидания следующего тика. */
    measureOnce: measureSafely,

    subscribe(subscriberId) {
      subscribers.add(subscriberId);
      start();
      return measureSafely();
    },

    unsubscribe(subscriberId) {
      subscribers.delete(subscriberId);
      if (subscribers.size === 0) stop();
    },

    isRunning() {
      return timer !== null;
    },

    subscriberCount() {
      return subscribers.size;
    },

    available() {
      return loadNative().ok;
    },

    /** Для тестов и диагностики: сбросить накопленное состояние. */
    reset() {
      previousSnapshot = null;
    },
  };
}

module.exports = {
  createProcessMetricsService,
  DEFAULT_INTERVAL_MS,
};
