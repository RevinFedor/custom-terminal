# Feature: Session Status (configurable tab markers)

## Intro
Маркер 8px (default круг, опционально квадрат) слева во вкладке в vertical layout. Назначается через ПКМ → Status. Сам список статусов — полный CRUD в Settings → Системные: label, hex, удаление, добавление. Дефолт-seed три статуса (dev/bugfix/knowledge), но юзер может полностью перекроить.

## Data model

`SessionStatusDef = { id: string, label: string, color: string }` в `useUIStore.sessionStatuses`. Tab.sessionStatus хранит **id**, не label и не color — переименование статуса в Settings не теряет ассоциацию у вкладок, цвет обновляется автоматически. `id` стабилен: дефолтные `dev`/`bugfix`/`knowledge`, custom = `status-<timestamp>-<rand>`.

Tab.sessionStatus в типах поднят до `string` (раньше был union из трёх литералов). Расширение для custom-id'ов. Backward compat: старые БД с `'dev'`/`'bugfix'`/`'knowledge'` ID'ами продолжают работать — те же id в дефолт-seed.

## Graceful degrade при удалении статуса

Юзер удаляет статус из Settings → статус исчезает из `sessionStatuses`. Tab.sessionStatus в БД **не чистится** — там остаётся id удалённого статуса. Маркер просто не рендерится (`sessionStatuses.find(s => s.id === tab.sessionStatus)` возвращает undefined → guard в TabBar.tsx).

Если юзер потом создаст статус с тем же id или импортирует обратно — все вкладки оживут с новым цветом/лейблом. Это намеренно: удаление статуса = временная очистка панели, не destructive для данных таба. Альтернатива (чистить Tab.sessionStatus при удалении статуса) теряла бы информацию при случайном клике в палитре.

## Marker shape + size

`statusMarker = { shape: 'dot' | 'square', sizePx: 4..16 }` — отдельная глобальная настройка, не per-статус. Юзер выбирает один раз и все маркеры рисуются одинаковой формой.

Centering геометрии: `left: 5px` (после 3px полоски процесса + 2px зазор), `top: calc(50% + 1px)` — `+1px` компенсирует оптический baseline-shift строчных букв (`claude-03` без descender'ов кажется ниже геометрического центра).

## CRUD UI (Settings → Системные)

Левая колонка 2-column grid. Сверху compact-row с shape toggle (визуальные dot/square превью кнопок) и `<input type="number">` для size. Дальше список SessionStatusDef-строк: цветной круг 20px (наследует выбранную shape) → text input для label → 7-char hex input → корзина.

Hex normalizer (`normalizeHexValue`) принимает `'fff'` / `'#fff'` / `'ffffff'` / `'#ffffff'`, всё что не парсится — null, caller оставляет старый цвет (защита от «промежуточный `#ab` ломает марк прямо в инпуте»). Локальный `hexDrafts` буфер позволяет печатать промежуточные значения без записи мусора в стор; blur → откат к каноническому из стора.

Цветной круг — кнопка, клик открывает `react-colorful` HexColorPicker (2D saturation×brightness + hue slider, ~3kb gzipped, без peer-deps). Picker открывается popup'ом под строкой, click-outside через `window.mousedown` listener с containment check на `containerRef`.

## Submenu preview в ПКМ-меню вкладки

Справа от лейбла `Status ›` в context menu отрисовываются 3 первых статуса как мини-точки 8px — preview палитры. Юзер видит «эта строка управляет вон теми цветными точками внутри вкладок» без открытия submenu. Если статусов >3 — показываются первые 3 (slice(0, 6) в исходнике как safety, но cap в 3-4 точки достаточен визуально).

В развёрнутом submenu — полный список с галочкой ✓ у выбранного. Toggle-семантика: клик на уже выбранный статус снимает его (`isSelected ? null : s.id`). Отдельной «Без статуса» кнопки нет — повторный клик и есть «снять».

Пустое состояние: если юзер удалил все статусы — submenu показывает italic-плейсхолдер «Нет статусов. Добавь в Settings → Системные.» — даёт куда идти без вылезания пустого блока.

## Persistence

localStorage ключ `noted-terminal-session-statuses` (массив JSON). `statusMarker` отдельным ключом `noted-terminal-status-marker`. Tab.sessionStatus идёт через стандартный saveTabs → SQLite. **Не зеркалится в SQLite через `app:mirrorLocalStorageSync`** — это локальная UI-настройка, синк между Electron-инстансами на разных машинах для конфигурации статусов не нужен (одна машина = одна палитра).

## Связи

- `knowledge/fact-tabs.md::Vertical mode (TabSidebar)` — где рендерится маркер.
- `knowledge/fact-process-bar.md` — process-bar с position toggle живёт в той же конфигурации.
- `methodology/design.md::Активность через насыщенность фона` — почему маркер не использует tint самой вкладки.
