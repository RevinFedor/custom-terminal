# Feature: Tab Process Bar (PTY-alive indicator)

## Intro
3px цветная полоска у одного из краёв вкладки в vertical layout. Появляется когда PTY-процесс жив (claude CLI, npm run dev, bash, gemini). Полностью конфигурируется в Settings → Системные: enabled/colors A+B/duration/position. Не путать с AI-shimmer (горизонтальная волна по всей ширине вкладки) — это разные индикаторы на разных осях, см. `methodology/design.md::Два независимых сигнала`.

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

## AI shimmer — keyframe range без visible snap

Соседний индикатор: `tab-ai-busy-shimmer` (горизонтальная полоса 60% ширины таба, бежит слева направо когда AI стримит). Используется linear-timing infinite loop. Распространённая ошибка — keyframes `translateX(-100%) → translateX(100%)`: на момент loop-снапа stripe-right-edge стоит на `100% + 30% (peak в середине own-width = 30% own-width = 18% таба) = 118% × 0.6 = 78%` от ширины таба — то есть яркий пик **виден** в правой 22%-зоне, потом мгновенно прыгает влево на -78%. Симптом — юзер: *«в самом конце она резко останавливается, должна плавно уходить вправо»*.

Решение — расширить keyframes до `translateX(-167%) → translateX(167%)`. Расчёт: stripe.width = 60% таба, peak в середине = 30% own-width = 18% таба от центра. Чтобы peak был ПОЛНОСТЬЮ off-screen на конце цикла, end translation = `100% + (50%/own-width) ≈ 167%`. На обоих концах stripe невидим, snap незаметен.

Период тоже 2.4s — синхронно с process-bar pulse, чтобы две анимации на одном табе (PTY claude в думанье) не «бились» разными частотами.

## Shimmer-rect выравнен с border-area вкладки

Аналогично process-bar: shimmer-wrapper изначально использовал `inset: 0` (растягивается до padding-edge). При `border-left: 2px solid transparent` это давало 2px gap слева, плюс `borderRadius: 6px` рендерился на узком rect — скругления shimmer'а не совпадали со скруглениями карточки. Решение — `top:0, bottom:0, left:-2px, right:-2px` (растянули в border-area с обеих сторон). Скругления теперь совпадают, gap исчез.

## Связи

- `methodology/design.md::Два независимых сигнала на одной зоне = два визуально разных индикатора` — почему PTY-bar и AI-shimmer разделены.
- `methodology/design.md::Snap у края при бесконечном translate-loop` — расчёт keyframe-range.
- `knowledge/fact-tabs.md::Vertical mode (TabSidebar)` — где рендерится полоска, как сосуществует с маркером статуса.
- `knowledge/fact-session-status.md::Marker shape + size` — параллельная конфигурация маркера в той же settings-секции.
- `CLAUDE.md::Anti-Patterns::AI-Optimized UI` — background-color pulse вместо opacity-pulse для H.264-читаемости в скринкастах (применяется здесь).
