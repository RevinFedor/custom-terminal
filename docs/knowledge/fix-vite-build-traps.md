# Fix: Vite-специфичные ловушки сборки (main + renderer)

Две независимые ловушки Vite, обе про **build-time трансформацию** кода, обе ломают приложение тихо.

## Часть 1: `$` в template literals = «Unexpected character $»

### Симптом
`npm run dev` падает на старте: `Transform failed: Unexpected character '$'`, указывает на `main.js`. Приложение не запускается. До этого работало — сломалось после правки bash-команды.

### Причина
В `main.js` шаблонные строки с bash-командами, содержащими переменные shell (`$PWD`, `$HOME`, `$9` в awk). Vite транспилирует main-процесс и видит `$` внутри `` ` `` как попытку JS-интерполяции — но `PWD`/`9` — не JS-выражения.

### Решение

**Простой случай — экранируй `$`:**
```js
const cmd = `echo \$PWD`;  // bash получит literal $PWD
```

**Сложный случай (awk и др.) — конкатенация:**
```js
// awk '{print $9}' — нельзя экранировать $9 в template literal
const cmd = 'lsof -p ' + pid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'';
```
Через `+ '\$' +` Vite видит `\$` как часть обычной строки (не template literal) и не пытается интерпретировать.

### Где это всплывает
- Любые spawn'ы bash из main с переменными.
- Особенно `lsof`, `awk`, `ps -o` с positional `$1`, `$2`, ...
- Не относится к renderer'у (там обычно нет shell-команд в template literals).

---

## Часть 2: `process.env.X` в renderer = `undefined` в production

### Симптомы
- API calls возвращают `key=undefined` в **production** (packaged app)
- В **dev** (`npm run dev`) всё работает
- Gemini/Anthropic API возвращает 400 «API key not valid»

### Причина
Vite заменяет `process.env.X` в renderer-коде на **литерал при сборке**. Если env var не определён в build-time контексте — подставится `undefined`. Main process работает с настоящим Node.js `process.env` (runtime), renderer — с замороженным снапшотом времени сборки.

### Решение — `define` в `electron.vite.config.js` с предварительной загрузкой `.env`:

```js
import { config } from 'dotenv';
const env = config({ path: resolve(__dirname, '.env') }).parsed || {};

export default defineConfig({
  renderer: {
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
      'process.env.ANTHROPIC_API_KEY': JSON.stringify(env.ANTHROPIC_API_KEY || ''),
    },
  },
});
```

Каждый env var, который renderer должен видеть, **явно** перечисляется в `define`. Не перечислил — будет `undefined` в production.

### Почему не другие подходы
- **`VITE_` префикс** (`import.meta.env.VITE_X`) — требует переписать **все** места использования в renderer, ломает единообразие с main (где `process.env.X` работает нативно).
- **IPC handler `app:getEnv`** — оверинжиниринг для статических значений (ключи API не меняются в runtime), плюс async везде где должно быть sync.
- **`.env` loader в main.js** — работает только для main process, renderer бандлится отдельно и не видит этот код.
