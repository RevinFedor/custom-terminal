// Базовая строка доклейки карты групп — переживает усыпление панели.
//
// Дешёвая доклейка (`buildHistoryDisplayUnitsAppended`) сравнивает новый список
// записей с ПРЕДЫДУЩИМ и пересобирает только хвост после последней жёсткой
// границы. Прежде «предыдущий» жил в ref внутри HistoryPanel и умирал вместе с
// панелью: окно уснуло (пространство переключили) — базовая строка исчезла.
//
// Для вкладки, которая в прошлый визит СТРИМИЛА, это означало полный проход по
// всем записям на каждом пробуждении: живое слияние строит новый массив, кэш по
// identity его не знает, а сравнивать больше не с чем. Замер 20.08 (прод):
// 15–17мс ×3 пробуждения на 1.8K-сессии, 62.8мс на 3.9K — чистое повторение
// уже посчитанного. Данные записи переживают панель (snapshot-кэш), значит и
// базовая строка обязана жить по СЕССИИ, не по смонтированности панели.
//
// Ограничение по памяти: LRU на несколько владельцев. Хранится ссылка на
// массив записей (он и так удерживается snapshot-кэшем) плюс лёгкие юниты.

const MAX_BASELINE_OWNERS = 16;

/** ownerKey → { ownerKey, entries, options, units } */
const baselinesByOwner = new Map();

export function peekHistoryDisplayUnitsBaseline(ownerKey) {
  if (!ownerKey) return null;
  const hit = baselinesByOwner.get(ownerKey);
  if (!hit) return null;
  // Порядок вставки Map — LRU-список: продвигаем.
  baselinesByOwner.delete(ownerKey);
  baselinesByOwner.set(ownerKey, hit);
  return hit;
}

export function rememberHistoryDisplayUnitsBaseline(baseline) {
  const ownerKey = baseline?.ownerKey;
  if (!ownerKey || !Array.isArray(baseline.entries) || !Array.isArray(baseline.units)) return;
  baselinesByOwner.delete(ownerKey);
  baselinesByOwner.set(ownerKey, baseline);
  while (baselinesByOwner.size > MAX_BASELINE_OWNERS) {
    const oldest = baselinesByOwner.keys().next().value;
    if (oldest === undefined) break;
    baselinesByOwner.delete(oldest);
  }
}

/** Для тестов: заглянуть в размер без побочных эффектов. */
export function historyDisplayUnitsBaselineCount() {
  return baselinesByOwner.size;
}
