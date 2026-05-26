# Fact: Global Dictation — переехало в Voice Record

Глобальная диктовка (system-wide hotkey + chip над Dock + paste в frontmost-приложение) больше **не живёт внутри Noted Terminal**. Полная реализация — в отдельном Electron-приложении Voice Record по адресу `/Users/fedor/Desktop/voice-record/`, установленному в `/Applications/Voice Record.app`. Документация — `/Users/fedor/Desktop/voice-record/docs/`.

## Симптомы для роутера

- Alt+\` не запускает запись или не останавливает повторно
- Текст после STOP вставляется в Noted Terminal вместо браузера/Telegram/Claude TUI
- Чип не появляется / клик по чипу не работает / чип следует за курсором без зажатой кнопки
- Меню над чипом не закрывается при клике вне приложения
- После Cmd+Tab → Cmd+V из Voice Record не вставляется в Noted Terminal (в свежепереключенный таб)
- После paste из Voice Record в буфере обмена остался старый текст вместо диктованного
- Voice Record при первом запуске показывает Settings даже когда autoLaunch включён
- Чип отображается с белым прямоугольником вокруг кнопки

## Почему вынесли

Корневая проблема in-app версии: Noted Terminal — обычный Electron app с Dock-иконкой и main window. macOS AppKit при закрытии нашего overlay-окна ищет следующий «key window» в стеке, и для regular app возвращает нашу main window → процесс становится frontmost → CGEventPost Cmd+V уходит в нас, а не в browser/Telegram. Заплатки (`@ashubashir/electron-panel-window` для NSPanel swap, `uiohook-napi` для outside-click) давали свои баги — white shadow ghost и beach-ball cursor соответственно.

Полное решение — accessory app (`LSUIElement=true` + `app.setActivationPolicy('accessory')`). Без Dock-иконки и без main window AppKit никогда не использует Voice Record как backup frontmost. Так делают Raycast, Wispr Flow, Superwhisper, Voice control.

Подробности в `/Users/fedor/Desktop/voice-record/docs/knowledge/fact-architecture.md::Почему отдельное приложение`.

## Что осталось shared с Noted Terminal

- **`~/.noted-terminal/.env`** — `SONIOX_API_KEY`. Один токен на оба приложения (Voice Record и in-tab dictation в NT). Voice Record читает на boot через dotenv.
- **`~/.noted-terminal/global-dictation/settings.json`** — common shape, Voice Record добавил поля `autoLaunch`, `connectTimeout`, `chipPosByDisplay` (NT-side игнорирует новые поля).
- **`~/.noted-terminal/global-dictation/history.json`** — формат расширен: каждая entry опционально содержит `audioPath: string`, указывающий на `audio/<ts>.wav`. NT-side при чтении игнорирует поле.
- **`~/.noted-terminal/global-dictation/audio/<ts>.wav`** — новый каталог, только Voice Record. См. `voice-record/docs/knowledge/fact-audio-history.md`.
- **Codesign cert «Noted Terminal Dev»** — общий self-signed cert. TCC grants (Accessibility, Microphone) валидны для обоих приложений, единый prompt на первое использование. См. [`fact-codesign-tcc.md`](fact-codesign-tcc.md).
- **In-tab dictation `DictationSession`** — Voice Record импортировал тот же класс что в NT ([`fact-dictation.md`](fact-dictation.md)), 1-в-1 с дополнением `allFrames[]` буфера для .wav.

## Что лечит NT-сторона ради Voice Record

- **Cmd+Tab DOM-refocus** ([`fact-cmd-tab-refocus.md`](fact-cmd-tab-refocus.md)) — после Cmd+Tab Chromium не auto-restore DOM focus, поэтому Cmd+V из Voice Record падал в никуда. NT теперь на `BrowserWindow.on('focus')` рассылает DOM event, terminal/SDK textarea per-tab подхватывают и фокусятся. Без этого фикса для in-tab paste из Voice Record надо было кликать на input явно перед hotkey.

## Файлы и куда смотреть

| Тема | Где документировано |
|---|---|
| Окна, lifecycle, state machine | `/Users/fedor/Desktop/voice-record/docs/knowledge/fact-architecture.md` |
| `cgpaste` (paste), `clickmon` (outside-click) Swift binary | `/Users/fedor/Desktop/voice-record/docs/knowledge/fact-native-helpers.md` |
| WAV запись, Reload, Play, autoLaunch | `/Users/fedor/Desktop/voice-record/docs/knowledge/fact-audio-history.md` |
| Все шрамы (13 штук) с детерминированными симптомами | `/Users/fedor/Desktop/voice-record/docs/knowledge/fix-history-archive.md` |
| Soniox transport / DictationSession class | [`fact-dictation.md`](fact-dictation.md) |
| Cmd+Tab DOM-refocus (NT-side фикс ради Voice Record) | [`fact-cmd-tab-refocus.md`](fact-cmd-tab-refocus.md) |
| Codesign + TCC (общий cert) | [`fact-codesign-tcc.md`](fact-codesign-tcc.md) |
| Логи Voice Record | `~/Library/Logs/voice-record/voice-record.log` |
