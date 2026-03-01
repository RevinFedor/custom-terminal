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
