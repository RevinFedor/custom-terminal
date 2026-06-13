# Fix: Production Logs Path (app.asar Trap)

## Проблема: Логи не пишутся в продакшене
В упакованной версии приложения (packaged Electron app) логи переставали записываться, хотя в режиме разработки всё работало корректно.

### Причина: Read-Only FS в ASAR
Изначально путь к логам вычислялся через `path.join(__dirname, '..', '..', 'logs')`. 
В упакованном приложении `__dirname` указывает на путь внутри `app.asar`. ASAR — это архив только для чтения. При попытке создать папку или файл внутри него Electron не выдавал явную ошибку в UI, но запись в поток (`_logStream`) молча прекращалась.

## Решение: Системные пути Electron
Для записи логов в продакшене необходимо использовать метод `app.getPath('logs')`, который возвращает стандартную системную директорию для логов текущего пользователя.

### Реализация (main.js)
```javascript
const LOG_DIR = isDev 
  ? path.join(__dirname, '..', '..', 'logs') 
  : app.getPath('logs');
```

### Пути на macOS:
- **Dev:** `<project_root>/logs/dev.log`
- **Production:** `~/Library/Logs/noted-terminal/production.log`

## Шрам: stdout EIO после закрытия parent terminal
Если Electron dev-процесс пережил терминал, из которого был запущен, его stdout/stderr могут стать broken pipe. Обычный `console.log` в main process тогда падает с `Error: write EIO`, Electron показывает modal `A JavaScript error occurred in the main process`, и после нажатия OK модалка появляется снова на следующих логах. Для пользователя это выглядит как приложение, которое невозможно закрыть: одно и то же окно ошибки всплывает много раз подряд.

Логирование main process не должно считать stdout надёжным транспортом. Любой wrapper вокруг `console.*` обязан ловить ошибки записи в stdout/stderr и деградировать в файл/тихий fallback, иначе диагностический лог сам становится crash-loop. Это особенно важно для Dashboard Stop dev-process flow: он существует именно для случая «parent terminal умер, Electron child остался жить».

## Build Optimization
Чтобы итоговый пакет не содержал старых логов из папки разработки, в конфигурацию сборщика (`package.json`) добавлена фильтрация:
```json
"files": [
  "dist/**/*",
  "src/main/**/*",
  "package.json",
  "!logs/**"
]
```

## См. также
- [`fact-ops-guide.md`](fact-ops-guide.md) — общие инструкции по инфраструктуре.
