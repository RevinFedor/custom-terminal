# Fix: Mobile timeline GoTo не находит цель

## Симптомы

- На mobile при тапе по таймлайн-записи (стрелка `↗`) в чате ничего не происходит — особенно на ранних записях (первая половина истории).
- Десктопный Timeline GoTo работает корректно, но через мобайл — мимо.
- Иногда GoTo попадает «куда-то рядом», иногда вообще никуда.
- В логе `[TimelineGoTo] NOT FOUND — anchor missing` для большинства старых uuid'ов.

## Причина

Mobile грузил history через `getSessionMessages` от Anthropic SDK, а timeline-drawer показывал результат `parseTimelineEntries` (наш JSONL-backtrace по `parentUuid`). На длинной сессии **uuids этих двух источников не пересекаются**.

Проверено на claude-02 (128 prompts):

| источник | количество messages | первый uuid |
|---|---|---|
| `getSessionMessages` (Anthropic SDK) | 1868 | `199cf180…` |
| `parseTimelineEntries` (active-branch backtrace) | 106 | `e5adda5c…` |

Anthropic SDK собирает messages по своим критериям — подтягивает orphan-ветки, post-compact дубли, фрагменты других сессий. Active-branch backtrace идёт строго по `parentUuid` от последней записи в JSONL. На длинных сессиях с rewinds/forks эти выборки расходятся.

Когда timeline отдавал uuid `e5adda5c`, в чате его не было → `querySelector('[data-entry-uuid="e5adda5c"]')` возвращал null. Чем ближе к началу истории — тем больше расхождение, тем чаще «не работает».

## Что пробовали до открытия

1. **Двойной requestAnimationFrame** перед поиском anchor — теория «layout не успел закоммититься после `display:none` drawer'а». Не помогло.
2. **Fallback prefix-match** — ищем по первым 8 символам uuid если полный не найден. Не помогло (uuid'ы вообще разные, не truncated).
3. **Diagnostic log endpoint `/api/log/client`** — добавили чтобы увидеть из mobile сколько anchors в DOM и какие первые 5. Из логов стало ясно: anchors есть, но другие uuids.
4. **Прямой curl на оба endpoint** дал картину: `historyCount=1868, timelineCount=106, uuids НЕ пересекаются`.

## Решение

Новый IPC `claude-sdk:active-branch-messages`:

```js
ipcMain.handle('claude-sdk:active-branch-messages', async (event, { sessionId, cwd }) => {
  // Read JSONL, build recordMap by uuid, walk back from last entry via parentUuid.
  // Return ALL types (user/assistant/tool_use/tool_result) in chain order.
});
```

Renderer-bridge `loadSDKHistory` action переключён на новый handler вместо `claude-sdk:load-history` (который дёргал `getSessionMessages`). Mobile reducer при этом не менялся — он принимает любой набор messages в формате SDK-стрима.

UUIDs anchor'ов в DOM теперь совпадают с uuid'ами в timeline → GoTo работает на любую запись независимо от глубины.

## Урок

**Для mobile/external клиентов, которые навигируют между timeline и chat, обязательно использовать единый алгоритм построения активной ветки — нельзя смешивать наш backtrace и SDK helper.** Любой их рассинхрон ломает anchors. Если когда-нибудь Anthropic SDK получит официальный «active branch» helper, его поведение надо сравнить с нашим перед миграцией — есть риск той же проблемы.

См. также [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) про общий алгоритм активной ветки и [`fact-mobile-web.md`](fact-mobile-web.md) про bridge-архитектуру.
