// Indexing failures need a durable, copyable diagnostic, including the project
// that failed. A successful retry does not silently dismiss the old incident.
export function showSemanticIndexFailureToast(showToast, payload = {}, now = Date.now()) {
  const projectPath = String(payload.projectPath || '');
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop();
  const message = `Не удалось обновить индекс${projectName ? `: ${projectName}` : ''}`;
  const error = String(payload.error || 'Причина не передана индексатором');
  const failedFiles = Array.isArray(payload.stats?.failedFiles) ? payload.stats.failedFiles : [];
  const report = [
    message,
    `Время: ${new Date(now).toISOString()}`,
    `Проект: ${projectPath || payload.projectId || 'не указан'}`,
    `Индексатор: ${payload.provider || 'не указан'}`,
    `Модель: ${payload.model || 'не передана'}`,
    `Ошибка: ${error}`,
    ...(failedFiles.length ? ['Файлы с ошибками:', ...failedFiles] : []),
  ].join('\n');
  const outcome = payload.stats?.sawSummary && payload.stats?.summaryErrors > 0
    ? 'Индексатор завершил попытку с ошибками и сохранил предыдущий индекс.'
    : 'Обновление индекса не подтверждено.';
  const details = `${outcome}\n${error}${failedFiles.length ? `\n\n${failedFiles.join('\n')}` : ''}`;
  showToast(message, 'error', 0, true, report, undefined, undefined, undefined, undefined, details);
}
