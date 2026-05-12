# Fix: Claude Code Session Bricked by Oversized Image (Many-Image Limit)

### Симптомы
- В Claude Code TUI на каждое сообщение приходит ошибка: `An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.`
- API возвращает 400 на любой prompt — даже на пустой текст без картинок.
- `/compact` помогает части пользователей, у нас не сработал — ошибка остаётся.
- Перезапуск приложения не помогает: картинка лежит в JSONL и при resume снова попадает в контекст.
- Сессия фактически заблокирована, единственный быстрый путь — start new session с потерей контекста.

---

## Root Cause: Many-Image Mode

Anthropic API имеет **два** лимита на размер картинок:
- **8000px** на длинную сторону — общий лимит на одиночные картинки.
- **2000px** на длинную сторону — активируется когда в одном запросе **больше ~20 картинок** (so-called "many-image requests").

Claude Code хранит каждую картинку в JSONL как base64 в оригинальном разрешении и **не даунскейлит** перед отправкой в API. После 20+ скриншотов в сессии (типичный сценарий: pasted Playwright screenshots, browser snapshots, Figma экспорты) автоматически активируется many-image режим, и **любая** картинка ≥2000px ломает все последующие запросы.

Регрессия становится острой после апгрейда на 1M context: сессия может бриковать на 42% контекста (423K/1M токенов), потому что лимит 2000px — legacy из эпохи 200K, не масштабируется с расширением окна.

**Upstream issues:**
- [#46656](https://github.com/anthropics/claude-code/issues/46656) — Oversized image permanently blocks session
- [#22378](https://github.com/anthropics/claude-code/issues/22378) — Missing error handler causes infinite retry
- [#34120](https://github.com/anthropics/claude-code/issues/34120) — Session unrecoverable when single image >2000px

---

## Невидимая ловушка: картинки внутри `tool_result.content[]`

Картинки в JSONL лежат в **двух разных местах**:

```js
// Уровень 1: верхний message.content (картинка от пользователя или ассистента)
entry.message.content = [
  { type: "text", text: "..." },
  { type: "image", source: { data: "base64...", media_type: "image/png" } }
]

// Уровень 2: внутри tool_result (например, Read файла-картинки или WebFetch)
entry.message.content = [
  {
    type: "tool_result",
    content: [
      { type: "image", source: { data: "base64...", media_type: "image/png" } }
    ]
  }
]
```

Простой проход по `message.content[]` находит только верхний уровень. В реальном кейсе из 48 картинок **42 лежали в `tool_result.content[]`** — простая чистка верхнего уровня их пропускала, нарушитель оставался в контексте.

Также картинка может лежать в `attachment.prompt[]` (manual paste image).

---

## Workaround: рекурсивный проход по JSONL

Не существует CLI команды от Anthropic для чистки. Только ручное редактирование `~/.claude/projects/<slug>/<sessionId>.jsonl`.

```python
import json, base64, struct

def get_img_size(data_b64):
    """Detect dimensions from base64 PNG/JPEG/WEBP/GIF without PIL."""
    data = base64.b64decode(data_b64[:100000])
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return struct.unpack('>I', data[16:20])[0], struct.unpack('>I', data[20:24])[0]
    if data[:2] == b'\xff\xd8':  # JPEG: walk markers
        # ... (найти SOF0/SOF2 marker, читать height/width)
    return None, None

def transform(obj):
    """Recursively replace oversized image blocks with text placeholder."""
    if isinstance(obj, dict):
        if obj.get('type') == 'image' and isinstance(obj.get('source'), dict):
            w, h = get_img_size(obj['source'].get('data', ''))
            LIMIT = 1568  # Anthropic safe-edge limit for many-image mode
            if w and h and (w >= LIMIT or h >= LIMIT):
                return {"type": "text", "text": f"[Image removed: {w}x{h}]"}
        return {k: transform(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [transform(x) for x in obj]
    return obj
```

Применять к **каждой строке JSONL**, рекурсивно — `transform()` пройдёт по `message.content`, `tool_result.content`, `attachment.prompt` и любой другой вложенной структуре.

**Backup обязателен:** `cp <session>.jsonl <session>.jsonl.bak` перед чисткой. Без бэкапа повторно поднять контекст невозможно.

---

## Что пробовали и почему не сработало

1. **`/compact`** — официальный workaround Anthropic. У ~30% пользователей в issue #46656 срабатывает. У нас — нет: `/compact` сам делает API-запрос, который тоже падает на той же картинке. Замкнутый круг.

2. **Удаление только картинок строго `>2000px`** — лимит 2000px **инклюзивный**: картинка 2000×886 тоже бракуется. Нужно `>=2000` ИЛИ безопаснее `>=1568` (рекомендация Anthropic для many-image).

3. **Удаление только верхнеуровневых `message.content[].image`** — пропускает `tool_result.content[].image`, которые составляют 80%+ картинок (от Read tool / Playwright / WebFetch). После чистки ошибка возвращается на следующем запросе.

4. **Замена картинки на `null` или пустой объект** — Claude Code re-validates JSONL и спотыкается на невалидной структуре. Нужен полноценный текстовый плейсхолдер: `{"type": "text", "text": "[Image removed]"}`.

5. **Resume сессии после чистки** — работает, но `claude --resume <id>` иногда подгружает stale cache (проверяет mtime файла). Перезапуск Claude Code решает.

---

## Превентивные меры

Workaround-хук на `Read` tool (PreToolUse) может блокировать загрузку картинок ≥2000px **до** попадания в контекст:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read",
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/hooks/image-size-guard.sh"
      }]
    }]
  }
}
```

Скрипт читает file_path, проверяет dimensions через `identify` (ImageMagick), exit 2 при нарушении — Claude Code не ставит файл в контекст. Покрывает только Read; pasted/dragged картинки бесконтрольны.

---

## См. также
- [`fact-claude-code-internals.md`](fact-claude-code-internals.md) — поведение Claude Code TUI и JSONL
- [`fact-backtrace-jsonl.md`](fact-backtrace-jsonl.md) — структура JSONL и chain recovery
