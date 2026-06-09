# Fix: mic-кнопка роняет весь рендерер (SIGSEGV) — ScriptProcessorNode через hardware destination

## Симптом

Клик по mic-кнопке в `ClaudeControlBar` (или Global Dictation recording) — и **весь
экран приложения ломается** / окно белеет / процесс рендерера умирает. Не toast,
не зависание — именно гибель окна. Юзер: *«при нажатии на кнопку просто, блять,
ломается весь экран, всё приложение»*.

## Воспроизведение по prod-логам

`production.log` показывает один и тот же паттерн на падающих попытках:

```
07:55:40.850 [R] [MicButton] start mode=pty-claude
07:55:40.850 [R] [Dictation] start() begin
07:55:42.649 [R] [Dictation] mic ok tracks=1
07:55:42.681 [R] [Dictation] audio ok rate=48000
07:55:42.811 [ERROR] Error sending from webFrameMain:  Render frame was disposed   ← ★ рендерер умер
07:55:44.855 [ERROR] Error sending from webFrameMain:  Render frame was disposed
...
```

Плюс в другом месте лог прямо называет сигнал: `Recording crashит SIGSEGV
exitCode 11`, и Global Dictation окна `render-process-gone {"reason":"killed",
"exitCode":15}` / SIGSEGV. Ключ: смерть наступает **сразу после `audio ok`** —
то есть после того как аудио-граф собран и `ScriptProcessorNode` начал «пулиться»
(fire `onaudioprocess`). До `token ok` дело не доходит.

Важно: падает **не каждый** раз. Часть сессий (05:28, 05:29) проходят весь цикл
(`token ok → ws.onopen → stop`) без проблем. Это интермиттентный нативный крэш,
не детерминированный JS-throw (иначе был бы `[ErrorBoundary]` в логе — его нет).

## Root cause

`ScriptProcessorNode` (deprecated) fires `onaudioprocess` только пока подключён к
узлу, дотягивающемуся до **destination**. Старый граф тянул его через хардварный
выход:

```
source → processor → gain(0) → ac.destination   // ac.destination = CoreAudio output unit
```

На macOS Electron этот hardware-render-path в WebRTC/Chromium периодически
**SIGSEGV'ит рендерер** (известная семья багов: deprecated SPN + buffer на
device-rate, [electron#25492](https://github.com/electron/electron/issues/25492),
рекомендация — не гонять SPN через железный выход / мигрировать на AudioWorklet).
`gain.value = 0` глушит звук логически, но узел всё равно подключён к
аудио-устройству вывода — крэш-путь именно в нём, не в громкости.

## Фикс: пул через off-device MediaStreamAudioDestinationNode

```ts
this.muteSink = this.ac.createMediaStreamDestination();
this.processor.connect(this.muteSink);   // вместо gain → ac.destination
```

`MediaStreamAudioDestinationNode` — это **настоящий** destination (значит SPN
продолжает пулиться, `onaudioprocess` fire'ит ровно так же), но он пишет в
off-device `MediaStream`, который мы **никогда не читаем**. Аудио не доходит до
CoreAudio output unit → крэш-путь исчезает. Захват не страдает: PCM мы снимаем
**внутри** `onaudioprocess` (`ev.inputBuffer.getChannelData(0)`), а не из этого
sink'а.

Cleanup обязан: `muteSink.disconnect()` + `muteSink.stream.getTracks().forEach(t
=> t.stop())`.

Применено в **обоих** движках (общий паттерн, общий риск):
- `src/renderer/utils/dictation.ts` (desktop — ControlBar mic + Global Dictation)
- `mobile-web/src/dictation.ts` (mobile-web — composer mic)

## Почему не AudioWorklet

AudioWorklet убрал бы SPN целиком (правильное долгосрочное решение), но:
1. Требует `addModule(blob:URL)` → Electron CSP `default-src 'self'` режет blob
   (см. [`fact-dictation.md::Почему ScriptProcessorNode`](fact-dictation.md)).
2. Это переписывание аудио-движка с риском новых багов и нужным device-тестом.

Off-device sink — минимальная, точечная замена одной строки графа, убирающая
именно крэш-путь, без расширения CSP и без смены модели захвата. Если SIGSEGV
вернётся — следующий шаг AudioWorklet + расширение CSP, не подкрутка этого.

## Проверка

Device-тест (нужен реальный мик, не headless): mic-кнопка → запись идёт, окно
живо, `production.log` показывает `audio ok` → `token ok` → `ws.onopen` без
`Render frame was disposed`. Прогнать 5-10 раз подряд (крэш интермиттентный).

## Связанное

- [`fact-dictation.md`](fact-dictation.md) — архитектура диктовки, граф,
  почему SPN а не AudioWorklet.
- [`fact-global-dictation.md`](fact-global-dictation.md) — системная диктовка,
  тот же `DictationSession`.
