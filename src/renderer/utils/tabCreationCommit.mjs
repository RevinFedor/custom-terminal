/**
 * Serialize the durable commit of newly created tabs per project.
 * The candidate Map is built only after earlier creations have published, and
 * it is never exposed when persistence rejects it.
 *
 * ── ОТМЕНА СОЗДАНИЯ ПРОХОДИТ ЗДЕСЬ, А НЕ ПОСЛЕ ──────────────────────────
 *
 * `persist` пишет запись на диск, `publish` синхронно показывает её
 * приложению: до publish вкладки нет ни в `workspace.tabs`, ни на экране, и
 * `Terminal` не может подхватить её `pendingAction`. Ровно в этом промежутке
 * заказчик создания может узнать, что результат уже не нужен — например,
 * закрыли место в полосе окна, ради которого вкладку и создавали.
 *
 * Проверять это ПОСЛЕ публикации нельзя. Опубликованная вкладка — обычная
 * рабочая вкладка: у неё живой PTY, она в списке, в неё уже могли напечатать,
 * и «отменить» её можно только обычным закрытием, то есть архивом и
 * остановкой процесса — задним числом, по догадке о том, принял её человек
 * или нет. Догадки здесь неизбежно ложные: session id появляется не сразу,
 * а `nameSetManually` фабрика SDK ставит себе сама.
 *
 * Поэтому отмена живёт в границе создания: `canPublish` спрашивают до записи
 * и повторно ПЕРЕД `publish`, и отказ означает «эта запись не выходит
 * наружу». Вызывающий доводит уже существующий откат НЕопубликованной
 * записи — тот же путь, что при отказе БД, — и это не закрытие вкладки.
 *
 * Опция узкая: без `canPublish` функция ведёт себя ровно как раньше, и все
 * прежние вызывающие ничего не замечают.
 *
 * @param {() => boolean} [canPublish] — результат ещё нужен? Спрашивается в
 *   последний момент перед синхронной публикацией.
 */
export function commitCreatedTabSnapshot({
  queue,
  projectId,
  isWorkspaceCurrent,
  getCurrentTabs,
  getPersistenceRevision,
  buildCandidateTabs,
  persist,
  publish,
  canPublish,
}) {
  return queue.enqueue(projectId, async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (!isWorkspaceCurrent()) {
        return { success: false, error: 'project_closed_during_tab_creation' };
      }
      const baseEntries = [...getCurrentTabs().entries()];
      const candidateTabs = buildCandidateTabs(new Map(baseEntries));
      if (typeof canPublish === 'function' && !canPublish(candidateTabs)) {
        return { success: false, cancelled: true, error: 'tab_creation_cancelled' };
      }
      const snapshot = await persist(candidateTabs);
      if (snapshot?.success === false) return snapshot;
      // The project can close/reopen while persistence is in flight. Its old
      // Map still exists in this closure, but cannot receive a new tab anymore.
      if (!isWorkspaceCurrent()) {
        return { success: false, error: 'project_closed_during_tab_creation' };
      }

      const currentEntries = [...getCurrentTabs().entries()];
      const mapUnchanged = currentEntries.length === baseEntries.length
        && currentEntries.every(([id, tab], index) => (
          baseEntries[index]?.[0] === id && baseEntries[index]?.[1] === tab
        ));
      const persistenceUnchanged = typeof getPersistenceRevision !== 'function'
        || snapshot?.persistenceRevision == null
        || Number(snapshot.persistenceRevision) === Number(getPersistenceRevision());
      if (!mapUnchanged || !persistenceUnchanged) {
        if (attempt === 4) {
          return { success: false, error: 'tab_creation_concurrent_mutation' };
        }
        continue;
      }

      // ПОСЛЕДНЯЯ проверка — вплотную к публикации, без единого await между
      // ней и `publish`: иначе между «ещё нужно» и «показали» снова
      // появлялось бы окно, в котором место успевает исчезнуть.
      if (typeof canPublish === 'function' && !canPublish(candidateTabs)) {
        // Это НЕ ошибка. Отдельный исход, чтобы вызывающий не показал человеку
        // «сбой базы» там, где произошла обычная отмена.
        return { success: false, cancelled: true, error: 'tab_creation_cancelled' };
      }

      publish(candidateTabs);
      return snapshot;
    }
    return { success: false, error: 'tab_creation_concurrent_mutation' };
  });
}
