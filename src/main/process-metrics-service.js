'use strict';

/**
 * Связывает сбор метрик с интерфейсом: держит предыдущий снимок (без него
 * нельзя посчитать текущую загрузку процессора) и отдаёт готовую раскладку.
 *
 * Два темпа, потому что у цифры два разных адресата.
 *
 * Открытая панель — это разбор по вкладкам и инструментам: он нужен часто
 * (2 с) и целиком. Чип в шапке — два итога, и ему хватает редкого шага (5 с)
 * и компактного payload вместо всей раскладки. Раньше был только первый режим, поэтому
 * закрытый чип не показывал ничего, пока по нему не кликнешь.
 *
 * Цена замера измерена и не зависит от числа вкладок: один проход по ~600
 * процессам системы стоит ~3 мс на снимок и ~1 мс на раскладку, пути и
 * аргументы процессов читаются один раз на номер и кэшируются. При шаге 5 с
 * это около 0.08% времени одного потока; реальный CPU считают по native delta. А вот
 * гонять при этом по IPC все 5+ КБ раскладки смысла нет: в фоне уходит только
 * два итога без строк процессов, полная раскладка — пока панель открыта.
 */

const { captureNativeSnapshot, computeCpuPercent, loadNative } = require('./process-metrics-source');
const { groupProcessMetrics } = require('./process-metrics-grouping');
const { groupApplications } = require('./process-metrics-applications');
const { captureSystemMemory } = require('./system-memory-source');

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_AMBIENT_INTERVAL_MS = 5000;

/**
 * Итог для чипа: то же число, что панель показывает в подписи «всего», но без
 * построчного разбора. Сумму считает раскладка (`totals.allBytes`), здесь её
 * только переупаковывают — вторая формула в другом месте разъехалась бы.
 */
function toAmbient(payload) {
  if (!payload || !payload.ok) {
    return { ok: false, reason: (payload && payload.reason) || 'measure-failed' };
  }
  return {
    ok: true,
    scannedAt: payload.scannedAt || null,
    totalBytes: (payload.totals && payload.totals.allBytes) || 0,
    commandBytes: payload.totals?.commandBytes ?? null,
    orphanCount: (payload.orphans && payload.orphans.count) || 0,
  };
}

function createProcessMetricsService({
  capture = captureNativeSnapshot,
  computeCpu = computeCpuPercent,
  group = groupProcessMetrics,
  groupApps = groupApplications,
  captureSystem = captureSystemMemory,
  collectContext,
  onUpdate,
  onAmbientUpdate,
  intervalMs = DEFAULT_INTERVAL_MS,
  ambientIntervalMs = DEFAULT_AMBIENT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = console,
} = {}) {
  if (typeof collectContext !== 'function') {
    throw new TypeError('collectContext must be a function');
  }

  let previousSnapshot = null;
  let timer = null;
  let ambientTimer = null;
  let ambientEnabled = false;
  const subscribers = new Set();
  const views = new Map();
  let panelSnapshot = null;
  let panelCpu = null;
  let panelPayload = null;
  let applications = null;

  function wantsApplications() {
    return [...views.values()].some(view => view === 'system');
  }

  function withApplications(payload) {
    if (!wantsApplications() || !panelSnapshot || !payload?.ok) return payload;
    // The same process snapshot is reused on a view switch; no new PID scan.
    if (!applications) {
      try {
        applications = { ...groupApps({ snapshot: panelSnapshot, cpuByPid: panelCpu }), memory: captureSystem() };
      } catch (error) {
        log.warn('[ProcessMetrics] application grouping failed: ' + (error?.message || error));
        applications = { available: false, reason: 'application-grouping-failed', scannedAt: panelSnapshot.scannedAt };
      }
    }
    return { ...payload, applications };
  }

  function measure() {
    const snapshot = capture();
    if (!snapshot || !snapshot.ok) {
      panelSnapshot = panelCpu = panelPayload = applications = null;
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

    const payload = { ok: true, ...grouped };
    if (subscribers.size > 0) {
      panelSnapshot = snapshot;
      panelCpu = cpuByPid;
      panelPayload = payload;
      applications = null;
      return withApplications(payload);
    }
    return payload;
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
      panelSnapshot = panelCpu = panelPayload = applications = null;
      log.warn('[ProcessMetrics] measure failed: ' + (error && error.message));
      return { ok: false, reason: 'measure-threw' };
    }
  }

  /**
   * Один замер обслуживает оба адресата. Когда панель открыта, её быстрый тик
   * заодно кормит чип: второй проход по процессам ради того же числа — чистая
   * трата, а два независимых замера ещё и разошлись бы во времени, и чип
   * показывал бы не то, что подпись под открытой панелью.
   */
  function publish(payload) {
    if (subscribers.size > 0 && typeof onUpdate === 'function') onUpdate(payload);
    if (ambientEnabled && typeof onAmbientUpdate === 'function') onAmbientUpdate(toAmbient(payload));
  }

  function tick() {
    publish(measureSafely());
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    // Медленный тик на время открытой панели не нужен: быстрый уже публикует
    // и итог тоже. Иначе два таймера гоняли бы снимок вразнобой.
    stopAmbientTimer();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
    // Снимок протухает, пока никто не смотрит: сравнивать свежий замер с
    // получасовой давности бессмысленно — «загрузка» размажется по интервалу
    // простоя и покажет почти ноль для активного процесса.
    previousSnapshot = null;
    panelSnapshot = null;
    panelCpu = null;
    panelPayload = null;
    applications = null;
    if (ambientEnabled) startAmbientTimer();
  }

  function startAmbientTimer() {
    if (ambientTimer || timer) return;
    ambientTimer = setIntervalFn(tick, ambientIntervalMs);
    if (typeof ambientTimer.unref === 'function') ambientTimer.unref();
  }

  function stopAmbientTimer() {
    if (!ambientTimer) return;
    clearIntervalFn(ambientTimer);
    ambientTimer = null;
  }

  return {
    /** Разовый замер — для первого показа панели, без ожидания следующего тика. */
    measureOnce: measureSafely,

    subscribe(subscriberId, { view = 'noted' } = {}) {
      subscribers.add(subscriberId);
      views.set(subscriberId, view === 'system' ? 'system' : 'noted');
      start();
      return measureSafely();
    },

    setView(subscriberId, view) {
      if (!subscribers.has(subscriberId)) return { ok: false, reason: 'not-subscribed' };
      views.set(subscriberId, view === 'system' ? 'system' : 'noted');
      if (!wantsApplications()) applications = null;
      return panelPayload ? withApplications(panelPayload) : { ok: false, reason: 'snapshot-unavailable' };
    },

    unsubscribe(subscriberId) {
      subscribers.delete(subscriberId);
      views.delete(subscriberId);
      if (!wantsApplications()) applications = null;
      if (subscribers.size === 0) stop();
    },

    /**
     * Фоновый итог для чипа в шапке. Включается один раз при готовности окна и
     * живёт, пока живёт окно: чип виден всегда, значит и число под ним должно
     * быть свежим всегда, а не появляться после клика.
     */
    enableAmbient() {
      if (ambientEnabled) return toAmbient(measureSafely());
      ambientEnabled = true;
      const payload = measureSafely();
      startAmbientTimer();
      return toAmbient(payload);
    },

    disableAmbient() {
      ambientEnabled = false;
      stopAmbientTimer();
      if (subscribers.size === 0) previousSnapshot = null;
    },

    isRunning() {
      return timer !== null;
    },

    isAmbientRunning() {
      return ambientTimer !== null;
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
  toAmbient,
  DEFAULT_INTERVAL_MS,
  DEFAULT_AMBIENT_INTERVAL_MS,
};
