export const SESSION_MISSING_TINT = '#d45b80';
export const SESSION_PARTIAL_TINT = '#d6a34a';
export const SESSION_STALE_VALUE_TINT = '#6f6f78';

export function sessionAvailabilityTone(availability) {
  const state = availability?.state || 'none';
  if (state === 'missing') return 'missing';
  if (state === 'partial' || state === 'archived') return 'partial';
  return 'normal';
}

export function sessionAvailabilityAccent(availability) {
  const tone = sessionAvailabilityTone(availability);
  return tone === 'missing'
    ? SESSION_MISSING_TINT
    : tone === 'partial'
      ? SESSION_PARTIAL_TINT
      : null;
}

export function sessionAvailabilityBackgroundImage(availability) {
  const tone = sessionAvailabilityTone(availability);
  if (tone === 'missing') {
    return 'linear-gradient(90deg, rgba(212,91,128,0.015), rgba(212,91,128,0.11))';
  }
  if (tone === 'partial') {
    return 'linear-gradient(90deg, rgba(214,163,74,0.01), rgba(214,163,74,0.08))';
  }
  return undefined;
}

export function sessionAvailabilityRailShadow(availability) {
  const accent = sessionAvailabilityAccent(availability);
  return accent ? `inset -3px 0 0 ${accent}` : null;
}

export function sessionDerivedSignalsStale(availability, runtimeActive = false) {
  return (availability?.state === 'missing' || availability?.state === 'archived')
    && runtimeActive !== true;
}

export function sessionHistoryActionUnavailable(availability) {
  return availability?.state === 'missing' || availability?.state === 'archived';
}

export function sessionAvailabilityLabel(availability) {
  if (availability?.state === 'missing') {
    if (availability?.reason === 'deleted-by-noted-terminal') return 'История удалена с диска';
    return 'Файл истории не найден на диске';
  }
  if (availability?.state === 'partial') return 'История неполная: отсутствует файл исходной сессии';
  if (availability?.state === 'archived') return 'Сессия находится в архиве Codex';
  return '';
}
