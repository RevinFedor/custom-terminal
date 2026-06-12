# Feature: Tab Process Bar (PTY-alive indicator)

## Intro
3px цветная полоска у одного из краёв вкладки в vertical layout. Появляется когда жив PTY-процесс (claude CLI, npm run dev, bash, gemini/codex) **или** AI стримит (`isBusy`); для SDK-табов аналог process-alive даёт `sdkProcessAlive`. Process-alive сигнал — статичный `colorA`, AI-busy сигнал — настраиваемый блик (`shimmerColor` + opacity + spacing) внутри той же полоски. Это **единственный** busy/process-индикатор: бывший фон-пульс всей вкладки (`tab-ai-busy-shimmer`, фича AIPulse) удалён целиком, см. секцию «AIPulse removed» ниже.

## Data model

```ts
ProcessBarSettings = {
  colorA: string,              // базовый цвет process-alive полоски
  shimmerColor: string,        // цвет блика поверх полоски
  shimmerSpacingPct: number,   // расстояние между бликами, clamp 20..200
  shimmerOpacityPct: number,   // прозрачность центра блика, clamp 5..100
  position: 'left' | 'right',
}
```

localStorage ключ `noted-terminal-process-bar`, дефолт `colorA: #155E75, shimmerColor: #FFFFFF, shimmerSpacingPct: 50, shimmerOpacityPct: 55, position: left`. Legacy `enabled/colorB/durationMs` больше не мигрируются в UI-смысл: пульса нет, второй цвет стал самостоятельным цветом блика только после явного выбора юзером.

## Дефолтная палитра — приглушённый cyan + белый блик

Базовая полоса — cyan-800 (`#155E75`), блик по умолчанию белый (`#FFFFFF`) с opacity 55%. Cyan выбран как промежуточный hue между зелёной и синей зонами палитры, чтобы НЕ конфликтовать:
- `#10B981` emerald (knowledge sessionStatus) — более зелёный, чем cyan
- `#4E86F8` blue (gemini brand) — более синий, чем cyan
- `#22C55E` lime (devServer brand) — холоднее-светлее

Юзер: *«полоска вертикальная сейчас выглядит очень плохо»* — первая версия была белая (`rgba(255,255,255, .18 ↔ .85)`), пульсировала через всю яркость от приглушённой до почти полного белого + box-shadow glow. Воспринималось как «вспышка», конкурировало по вниманию с самим содержимым таба. Пульс позже убрали целиком: process-alive должен быть стабильным маркером, а движение принадлежит только loader-блику.

## Полоска ловит два сигнала: PTY-alive + AI-busy

Полоска рендерится при `hasProcess || isBusy`. Внутри неё одновременно живут два независимых индикатора:

1. **Process-alive (`hasProcess || sdkProcessAlive`)** → статичная `colorA` полоска. Это исходный режим для claude/gemini/codex CLI, npm run dev, bash и SDK runtime.
2. **AI-busy (`isBusy`)** → полупрозрачная просвечка `shimmerColor` ползёт сверху вниз поверх цветного фона. Сигнал `claude:busy-state`/`gemini:busy-state`/`codex:busy-state`/`claude-sdk:busy-state` плюс короткий `claude:paste-busy` вокруг `safePasteAndSubmit`.

Если живы оба — статичная полоса и блик идут одновременно. Если только AI без process-alive — полоска всё равно появляется со статичным `colorA`, по ней ползёт блик. Если только процесс без AI — только статичная полоса. `overflow:hidden` держит shimmer строго внутри полоски.

## AI-busy блик (light-overlay поверх цветной полоски)

Блик теперь configurable: пользователь отдельно выбирает `shimmerColor`, `shimmerOpacityPct` и `shimmerSpacingPct`. Это появилось после живого симптома: выбранный красный блик выглядел не красным, потому что прозрачность была зашита слишком высокой. Цвет без opacity-контрола не даёт пользователю предсказуемого результата.

**Эволюция подходов к continuous flow.** Сначала был один overlay translateY `-100% → 250%` — пик внутри полоски ~70% цикла, остальные 30% его не видно → юзер читает как «лоадер прыгает». Потом два overlay'я с `animation-delay: -0.6s` — на широких частях периода юзер видит **ДВА блика одновременно** (один уходит снизу, второй уже появился сверху), это уродует визуал в узкой 3px полоске. Потом repeat-y gradient с pattern 200% и пик на 50% — на стыках tile'ов 60% pattern имело alpha 0 подряд (хвост tile_n + начало tile_n+1), пик надолго пропадал.

Текущий вариант — **seamless wrapping gradient**: один `.tab-process-bar-ai-shimmer-overlay`, `background-repeat: repeat-y`, `background-size: 100% var(--process-bar-shimmer-spacing)`, пик на 50% tile, edge-alpha = `shimmerOpacityPct * .22`. На стыках двух tile'ов alpha с обеих сторон одинаковая → нет тёмной паузы, есть мягкий valley между движущимися пиками. `background-position 0 → 100%` за 1.2s сдвигает на один tile, конец цикла визуально идентичен началу благодаря repeat-y. Юзер: *«прерывается на долю секунды во время лоудера когда заходит в конце и появляется в начале»* — этот шов теперь физически отсутствует.

Один overlay (`.tab-process-bar-ai-shimmer-overlay`), никаких secondary-инстансов. Если в будущем нужно убавить общий glow — снижать `shimmerOpacityPct`, не менять geometry.

## CSS-var bridge (live-tunable анимация)

`App.tsx` синхронизирует на `document.documentElement.style`:

- `--process-bar-color-a`
- `--process-bar-shimmer-rgb`
- `--process-bar-shimmer-spacing`
- `--process-bar-shimmer-alpha`
- `--process-bar-shimmer-edge-alpha`

Все instance'ы полоски (табовая, проектная, mobile-web mirror) автоматически перестраиваются без props-propagation. Юзер двигает color picker / opacity input → CSS-переменные подхватываются следующим кадром.

**Почему не inline-style на каждом узле:** была бы props-цепочка `useUIStore → TabBar → TabItem → div.style`, плюс memo invalidation на каждый picker-tick. С :root variables — одно DOM-mutation на изменение Settings, никаких React-перерисовок.

## ProcessBar position toggle

`position: 'left' | 'right'` — рисуется у левого или правого края вкладки. `[processBarPosition === 'right' ? 'right' : 'left']: -2px` + закругление углов только на «своей» стороне (`borderTopLeftRadius` или `borderTopRightRadius`). Юзер: *«добавь также тогл переключатель, чтобы она отображалась справа вкладки в правом конце»*.

**Почему `-2px`, не `0`.** Сама вкладка имеет `border-left: 2px solid transparent` (резерв под dashed-states selected/interrupted чтобы все табы не дёргались по ширине при включении выделения). Абсолютные дети с `left: 0` позиционируются от **padding-edge**, не от outer perimeter — отрисовываются ВНУТРИ border-area, между transparent border'ом и контентом. Визуально это даёт 2px зазор между полоской и реальным краем карточки. Симптом — юзер: *«полоска не прижата, там расстояние где-то в 1-2 пикселя есть»*. Фикс — `left: -2px` (соответственно `right: -2px` при position=right), полоска занимает border-area целиком, упирается в outer-edge.

Маркер sessionStatus всегда слева независимо от bar-position — потому что слева удобнее читается рядом с текстом названия вкладки. Если bar тоже слева — между ними 2px зазор; если bar справа — слева остаётся padding под маркер.

## Settings UI (правая колонка 2-column grid)

- Compact превью полоски 32px высотой с реальной анимацией (использует локальные CSS-vars в `style={{['--process-bar-color-a' as any]: ...}}`, не зависит от :root — превью обновляется ДО того как App-effect синхронизирует root)
- Position toggle (`⊏ слева` / `⊐ справа`) inline в одной строке
- Compact color-rows для «Полоса» (`colorA`) и «Блик» (`shimmerColor`)
- «Расстояние» — number input для `shimmerSpacingPct`
- «Плотность» — number input для `shimmerOpacityPct`

Toggle «Пульс», второй цвет как pulse-phase и «Цикл» удалены: в реальной модели нет пульсации, есть переливание блика. Держать старые контролы опасно — пользователь меняет настройку и не получает ожидаемого эффекта, потом диагностирует не тот слой.

## AIPulse removed — лоадер это полоска, не фон всего таба

**Фича AIPulse (`tab-ai-busy-shimmer`/`-static`, пульс фона ВСЕЙ карточки таба) удалена целиком.** Юзер: *«если в настройках есть что-то что отвечает за изменение бэкграунда всего таба во время работы — удали это нахуй; лоадер у нас отвечает переливающаяся полоска слева или справа»*. Единственный AI-busy / process-alive индикатор теперь — **process-bar полоска у края** (этот файл, секции выше): статичный базовый цвет пока жив процесс, настраиваемый shimmer-overlay ползёт по ней пока AI реально стримит.

Что снесено (5 точек, искать если всплывёт): `AIPulseSettings`/`aiPulse`/`setAiPulse`/`loadAIPulse`/`saveAIPulse` в `useUIStore.ts`; `--ai-pulse-*` :root-effect в `App.tsx`; `tab-ai-busy-*` render-блок в `TabBar.tsx`; `@keyframes tab-ai-busy-pulse` + `.tab-ai-busy-shimmer/-static` в `globals.css`; `AIPulseEditor` + «Фон AI-загрузки» секция в `SettingsModal.tsx`. Никаких importers не осталось.

Исторический контекст (почему вообще была): сначала был sweep-шиммер (горизонтальная полоса 60% ширины через `translateX`), потом фон-pulse всей карточки — юзер тогда просил *«сделай пульсацию фона»*. Теперь решение откатано в пользу полоски-у-края: фон-tint всего таба конкурировал с текстом за внимание, лоадер должен быть локализован в полоске.

## Mobile-web зеркалит полоску (process-bar = лоадер на телефоне)

Mobile-web tab-row рисует **ту же полоску-лоадер** у края строки (`ProcessBarStrip` в `mobile-web/src/App.tsx`). Конфиг (`colorA/shimmerColor/shimmerSpacingPct/shimmerOpacityPct/position`) приходит из desktop `useUIStore.processBar` через тот же канал что `statusMarker`/`statusColor`: `GET /api/projects/:id/tabs` отдаёт top-level `processBar`, оба пути (DB-path web-server.js через bridge `getStatusMarkerConfig`, live-Zustand-path App.tsx `getProjectTabsLive`) читают `useUIStore.getState().processBar`. **Desktop store = единственный источник правды, мобилка только читает** (юзер: «по-хорошему чтобы хранилось в одном состоянии»).

Маппинг рантайма на полоску: `running` (sessionStatus active/busy или SDK live) → статичная `colorA` полоса. `busy` (turn в полёте) → плюс `.mob-pbar-shimmer` с теми же цветом/spacing/opacity. `position:right` → `{right:0}` + правые радиусы, иначе левые — зеркало desktop edge-anchoring. Строка резервирует `paddingLeft/Right:17` на стороне полоски чтобы текст не лез под неё. Старый whole-row background-breathing (`mob-row-busy`) и правая точка/ring удалены — полоска единственный лоадер, как на desktop. Graceful degrade: старый сервер без `processBar` → дефолт cyan/left.

## Project tabs агрегируют сигнал бейджем, не полоской

Вкладка проекта в titlebar показывает активность дочерних вкладок через круглый зелёный count-badge с цифрой активных процессов внутри, а не через session-level edge-strip. Юзер зафиксировал границу после регресса: *«у проектов должен быть кружочек, как раньше, с цифрой посередине; у вкладок сессии — вертикальная чёрточка»*. Поэтому правило *«если он отображается на вкладке, то он отображается на проекте»* означает перенос **сигнала**, а не копирование визуальной формы.

Edge-strip (`tab-process-bar-static` + shimmer) принадлежит только дочерним session tabs: он показывает live process / AI-busy у конкретной вкладки. Project tab — агрегирующая поверхность навигации между проектами, и ему нужен счётчик, чтобы пользователь видел масштаб фоновой работы в проекте. Не возвращать `hasProcessBar` / `tab-process-bar-static` в `ProjectTabItem`: такая попытка уже делала родительскую вкладку похожей на session-tab и убирала count-семантику.

## Связи

- `methodology/переносимый-дизайн.md::Два независимых сигнала на одной зоне = два визуально разных индикатора` — почему process-alive и AI-busy разделены на base strip + shimmer.
- `methodology/переносимый-дизайн.md::Лоадер = локализованный элемент, не заливка всей поверхности` — переносимый принцип, по которому AIPulse (фон всей вкладки) удалён в пользу краевой полоски.
- `methodology/переносимый-дизайн.md::Snap у края при бесконечном translate-loop` — расчёт keyframe-range (sweep-блик `-100%→250%`).
- `knowledge/fact-tabs.md::Vertical mode (TabSidebar)` — где рендерится полоска, как сосуществует с маркером статуса.
- `knowledge/fact-session-status.md::Marker shape + size` — параллельная конфигурация маркера в той же settings-секции.
- `CLAUDE.md::Anti-Patterns::AI-Optimized UI` — loader должен давать сильную пиксельную дельту в записи экрана; поэтому блик движется как visible gradient внутри полоски, а не opacity-only pulse всей вкладки.
