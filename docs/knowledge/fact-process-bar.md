# Feature: Tab Process Bar (PTY-alive indicator)

## Intro
3px цветная полоска у одного из краёв вкладки в vertical layout. Появляется когда жив PTY-процесс (claude CLI, npm run dev, bash, gemini) **или** AI стримит (`isBusy`). PTY-сигнал даёт цветной пульс A↔B, AI-сигнал — белёсый блик ползёт сверху вниз поверх цвета. Оба могут идти одновременно. Конфигурируется в Settings → Системные: enabled/colors A+B/duration/position; блик не конфигурируется (фиксированный белёсый light-overlay). Это **единственный** busy/process-индикатор — бывший фон-пульс всей вкладки (`tab-ai-busy-shimmer`, фича AIPulse) удалён целиком, см. секцию «AIPulse removed» ниже.

## Data model

```ts
ProcessBarSettings = {
  enabled: boolean,        // false → статичный colorA, без анимации
  colorA: string,          // нижняя фаза пульса (или единственный цвет если enabled=false)
  colorB: string,          // верхняя фаза пульса
  durationMs: number,      // длительность одного цикла, clamp 300..6000ms
  position: 'left' | 'right',
}
```

localStorage ключ `noted-terminal-process-bar`, дефолт `enabled: true, colorA: #155E75, colorB: #0E7490, durationMs: 2400, position: left`.

## Дефолтная палитра — приглушённый cyan

Cyan-800 (`#155E75`) ↔ cyan-700 (`#0E7490`). Между ними очень узкая дельта яркости — пульс читается как «дыхание», не как «вспышка». Чтобы НЕ конфликтовать:
- `#10B981` emerald (knowledge sessionStatus) — более зелёный, чем cyan
- `#4E86F8` blue (gemini brand) — более синий, чем cyan
- `#22C55E` lime (devServer brand) — холоднее-светлее

Юзер: *«полоска вертикальная сейчас выглядит очень плохо»* — первая версия была белая (`rgba(255,255,255, .18 ↔ .85)`), пульсировала через всю яркость от приглушённой до почти полного белого + box-shadow glow. Воспринималось как «вспышка», конкурировало по вниманию с самим содержимым таба. Заменили на узкий cyan-диапазон без glow — задний фон «теплится», не «мигает».

## Полоска ловит два сигнала: PTY-alive + AI-busy

Полоска рендерится при `hasProcess || isBusy`. Внутри неё одновременно живут два независимых индикатора:

1. **PTY-alive (`hasProcess`)** → цветной пульс A↔B (или статика colorA если `processBar.enabled=false`). Это исходный режим — claude CLI, npm run dev, bash, gemini CLI.
2. **AI-busy (`isBusy`)** → белёсая полупрозрачная просвечка ~40% высоты ползёт сверху вниз поверх цветного фона. Сигнал `claude:busy-state`/`gemini:busy-state`/`claude-sdk:busy-state`. Особенно важно для SDK-табов где PTY нет — полоска появляется со статичным colorA, по ней ползёт блик; раньше для SDK единственным сигналом был фон-pulse всей вкладки.

Если живы оба — пульс цветом и блик идут одновременно (overflow:hidden на полоске обрезает overlay на off-screen фазах). Если только AI без PTY — полоска статичная, блик ползёт. Если только PTY без AI — пульс без блика, как раньше.

Юзер хочет вытеснить фон-pulse всей вкладки (`tab-ai-busy-shimmer`) этим бликом, но пока оба сигнала работают параллельно — фон-pulse удалится позже отдельным шагом.

## AI-busy блик (light-overlay поверх цветной полоски)

```css
@keyframes tab-process-bar-ai-shimmer {
  0%   { transform: translateY(-100%); }
  100% { transform: translateY(250%); }
}
.tab-process-bar-ai-shimmer-overlay {
  position: absolute; left: 0; right: 0; height: 40%;
  background: linear-gradient(
    to bottom,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,0.55) 50%,
    rgba(255,255,255,0) 100%
  );
  animation: tab-process-bar-ai-shimmer 1.2s linear infinite;
}
```

Цвет блика — фиксированный белёсый rgba, **не конфигурируется**. Это узнаваемая light-overlay метафора material linear-progress: одна и та же светлая полоса читается «загрузка идёт» поверх любого цвета полоски. Делать отдельный color-picker для блика — лишний контрол в Settings без продуктовой пользы; user-customizable остаётся базовый цвет полоски (colorA/colorB), блик одинаков везде. См. `methodology/переносимый-дизайн.md::Снижение visual noise через стандартный light-overlay` (новый раздел).

Loop `-100% → 250%` даёт чистый цикл без снапа: первая фаза полностью off-screen сверху, фаза 250% полностью off-screen снизу — на стыках overlay невидим, переход на новый цикл не видно. Принцип «Snap у края при бесконечном translate-loop» из `methodology/переносимый-дизайн.md`. `height: 40%` — overlay занимает чуть меньше половины полоски, чтобы пик блика был узнаваемой формой, а не «полоска целиком стала белой».

**Эволюция подходов к continuous flow.** Сначала был один overlay translateY `-100% → 250%` — пик внутри полоски ~70% цикла, остальные 30% его не видно → юзер читает как «лоадер прыгает». Потом два overlay'я с `animation-delay: -0.6s` — на широких частях периода юзер видит **ДВА блика одновременно** (один уходит снизу, второй уже появился сверху), это уродует визуал в узкой 3px полоске. Потом repeat-y gradient с pattern 200% и пик на 50% — на стыках tile'ов 60% pattern имело alpha 0 подряд (хвост tile_n + начало tile_n+1), пик надолго пропадал.

Текущий вариант — **seamless wrapping gradient в pattern `100% 50%`**: один tile вмещается в половину полоски, всего видно 2 tile'а сразу. Pattern: alpha .12 на 0% и 100%, пик .55 на 50%. На стыках двух tile'ов alpha с обеих сторон одинаковая (.12) → нет тёмной паузы, есть мягкий valley между двумя движущимися пиками. `background-position 0 → 100%` за 1.2s сдвигает на ровно один tile, на конце цикла позиция визуально идентична начальной благодаря `repeat-y` → loop seamless. Юзер: *«прерывается на долю секунды во время лоудера когда заходит в конце и появляется в начале»* — этот шов теперь физически отсутствует, alpha никогда не падает до 0.

Один overlay (`.tab-process-bar-ai-shimmer-overlay`), никаких secondary-инстансов. Если в будущем нужно убавить общий glow — снизить base alpha с .12 до .06; пик можно тюнить через .55→.45.

## CSS-var bridge (live-tunable анимация)

```css
@keyframes tab-process-bar-pulse {
  0%, 100% { background-color: var(--process-bar-color-a, #155E75); }
  50%      { background-color: var(--process-bar-color-b, #0E7490); }
}
.tab-process-bar-busy {
  animation: tab-process-bar-pulse var(--process-bar-duration, 2.4s) ease-in-out infinite;
}
.tab-process-bar-static {
  background-color: var(--process-bar-color-a, #155E75);
}
```

`App.tsx` через `useEffect([processBar.colorA, colorB, durationMs])` ставит три переменные на `document.documentElement.style`. Все instance'ы полоски (а их N штук — по одной на каждом активном табе) автоматически перестраиваются без props-propagation, без re-render'а TabBar. Юзер двигает react-colorful picker → keyframe моментально берёт новый цвет с следующего кадра.

**Почему не inline-style на каждом узле:** была бы props-цепочка `useUIStore → TabBar → TabItem → div.style`, плюс memo invalidation на каждый picker-tick. С :root variables — одно DOM-mutation на изменение Settings, никаких React-перерисовок.

## ProcessBar position toggle

`position: 'left' | 'right'` — рисуется у левого или правого края вкладки. `[processBarPosition === 'right' ? 'right' : 'left']: -2px` + закругление углов только на «своей» стороне (`borderTopLeftRadius` или `borderTopRightRadius`). Юзер: *«добавь также тогл переключатель, чтобы она отображалась справа вкладки в правом конце»*.

**Почему `-2px`, не `0`.** Сама вкладка имеет `border-left: 2px solid transparent` (резерв под dashed-states selected/interrupted чтобы все табы не дёргались по ширине при включении выделения). Абсолютные дети с `left: 0` позиционируются от **padding-edge**, не от outer perimeter — отрисовываются ВНУТРИ border-area, между transparent border'ом и контентом. Визуально это даёт 2px зазор между полоской и реальным краем карточки. Симптом — юзер: *«полоска не прижата, там расстояние где-то в 1-2 пикселя есть»*. Фикс — `left: -2px` (соответственно `right: -2px` при position=right), полоска занимает border-area целиком, упирается в outer-edge.

Маркер sessionStatus всегда слева независимо от bar-position — потому что слева удобнее читается рядом с текстом названия вкладки. Если bar тоже слева — между ними 2px зазор; если bar справа — слева остаётся padding под маркер.

## Enabled toggle (без пульса)

`enabled: false` → класс `tab-process-bar-static` вместо `tab-process-bar-busy`. Тот же background-color из var(--color-a), но без `animation`. Юзер видит цветную полоску, она не моргает.

Settings-UI: при выключенном пульсе input цвета B и slider duration становятся `disabled` (opacity 0.4) — видно что параметры неактивны, но не убраны из DOM (легко включить обратно).

## Settings UI (правая колонка 2-column grid)

- Compact превью полоски 32px высотой с реальной анимацией (использует локальные CSS-vars в `style={{['--process-bar-color-a' as any]: ...}}`, не зависит от :root — превью обновляется ДО того как App-effect синхронизирует root)
- Toggle «Пульс» + position toggle (`⊏ слева` / `⊐ справа`) inline в одной строке
- Compact color-rows для A и B (button → hex input, popup picker)
- Длительность — `<input type="number">` 64px справа от лейбла, в **милисекундах** (300..6000, step 100). Юзер: *«длительность цикла сделай input обычный, нахуй ты это вынес на целую огроменную полоску, которая занимает всю ширину»* — первая итерация была `<input type="range">` на всю ширину блока, оказалась визуально доминирующей. Number input компактнее, не претендует на главенство.

## AIPulse removed — лоадер это полоска, не фон всего таба

**Фича AIPulse (`tab-ai-busy-shimmer`/`-static`, пульс фона ВСЕЙ карточки таба) удалена целиком.** Юзер: *«если в настройках есть что-то что отвечает за изменение бэкграунда всего таба во время работы — удали это нахуй; лоадер у нас отвечает переливающаяся полоска слева или справа»*. Единственный AI-busy / process-alive индикатор теперь — **process-bar полоска у края** (этот файл, секции выше): цветной пульс A↔B пока жив процесс, белёсый shimmer-overlay ползёт по ней пока AI реально стримит.

Что снесено (5 точек, искать если всплывёт): `AIPulseSettings`/`aiPulse`/`setAiPulse`/`loadAIPulse`/`saveAIPulse` в `useUIStore.ts`; `--ai-pulse-*` :root-effect в `App.tsx`; `tab-ai-busy-*` render-блок в `TabBar.tsx`; `@keyframes tab-ai-busy-pulse` + `.tab-ai-busy-shimmer/-static` в `globals.css`; `AIPulseEditor` + «Фон AI-загрузки» секция в `SettingsModal.tsx`. Никаких importers не осталось.

Исторический контекст (почему вообще была): сначала был sweep-шиммер (горизонтальная полоса 60% ширины через `translateX`), потом фон-pulse всей карточки — юзер тогда просил *«сделай пульсацию фона»*. Теперь решение откатано в пользу полоски-у-края: фон-tint всего таба конкурировал с текстом за внимание, лоадер должен быть локализован в полоске.

## Mobile-web зеркалит полоску (process-bar = лоадер на телефоне)

Mobile-web tab-row рисует **ту же полоску-лоадер** у края строки (`ProcessBarStrip` в `mobile-web/src/App.tsx`). Конфиг (`enabled/colorA/colorB/durationMs/position`) приходит из desktop `useUIStore.processBar` через тот же канал что `statusMarker`/`statusColor`: `GET /api/projects/:id/tabs` отдаёт top-level `processBar`, оба пути (DB-path web-server.js через bridge `getStatusMarkerConfig`, live-Zustand-path App.tsx `getProjectTabsLive`) читают `useUIStore.getState().processBar`. **Desktop store = единственный источник правды, мобилка только читает** (юзер: «по-хорошему чтобы хранилось в одном состоянии»).

Маппинг рантайма на полоску: `running` (sessionStatus active/busy или SDK live) → полоска видна, пульс A↔B (`@keyframes mob-pbar-pulse`, vars `--mob-pbar-a/b` inline per-row). `busy` (turn в полёте) → плюс sweep-band `.mob-pbar-shimmer` (`translateY -100%→250%`, seamless). `position:right` → `{right:0}` + правые радиусы, иначе левые — зеркало desktop edge-anchoring. Строка резервирует `paddingLeft/Right:17` на стороне полоски чтобы текст не лез под неё. Старый whole-row background-breathing (`mob-row-busy`) и правая точка/ring удалены — полоска единственный лоадер, как на desktop. Graceful degrade: старый сервер без `processBar` → дефолт cyan/left.

## Связи

- `methodology/переносимый-дизайн.md::Два независимых сигнала на одной зоне = два визуально разных индикатора` — почему PTY-alive пульс и AI-busy блик разделены геометрически внутри полоски.
- `methodology/переносимый-дизайн.md::Лоадер = локализованный элемент, не заливка всей поверхности` — переносимый принцип, по которому AIPulse (фон всей вкладки) удалён в пользу краевой полоски.
- `methodology/переносимый-дизайн.md::Snap у края при бесконечном translate-loop` — расчёт keyframe-range (sweep-блик `-100%→250%`).
- `knowledge/fact-tabs.md::Vertical mode (TabSidebar)` — где рендерится полоска, как сосуществует с маркером статуса.
- `knowledge/fact-session-status.md::Marker shape + size` — параллельная конфигурация маркера в той же settings-секции.
- `CLAUDE.md::Anti-Patterns::AI-Optimized UI` — background-color pulse вместо opacity-pulse для H.264-читаемости в скринкастах (применяется здесь).
