# ОПЫТ: Промежуточное состояние "Ожидание сессии"

## Проблема
При запуске Claude без Default Prompt (промпт отключен в настройках) InfoPanel показывал "Нет активной сессии", хотя Claude CLI уже работал в терминале. Причина:

1. **Claude Sniper Watcher** отслеживает появление новых `.jsonl` файлов в `~/.claude/projects/<slug>/`.
2. Claude CLI **не создаёт** `.jsonl` файл при запуске — он создаётся только **после первого обмена сообщениями**.
3. Без Default Prompt пользователь сам должен ввести первый промпт. До этого момента Sniper не может ничего поймать.
4. InfoPanel видит `claudeSessionId === null` и показывает "Нет активной сессии" — это вводит в заблуждение.

## Решение: Трёхуровневое состояние
В InfoPanel добавлено отслеживание `commandType` таба (через поллинг store каждые 500мс):

```
commandType === 'claude'/'gemini' && sessionId → Активная сессия (зелёный)
commandType === 'claude'/'gemini' && !sessionId → Ожидание сессии... (жёлтый, пульс)
!commandType || commandType === null → Нет активной сессии (серый)
```

### Код (InfoPanel.tsx)
```tsx
const [activeCommandType, setActiveCommandType] = useState<string | null>(null);

// В поллинге:
setActiveCommandType(tab.commandType || null);

// В JSX:
) : (activeCommandType === 'claude' || activeCommandType === 'gemini') ? (
  <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
  <span className="text-yellow-500/80 text-xs">Ожидание сессии...</span>
) : (
  <span className="w-2 h-2 rounded-full bg-[#666]"></span>
  <span className="text-[#888] text-xs">Нет активной сессии</span>
)
```

## Когда Sniper срабатывает
- **С Default Prompt:** Промпт отправляется автоматически через Handshake → Claude отвечает → `.jsonl` создан → Sniper ловит → `claudeSessionId` установлен → InfoPanel переключается на "Активная сессия".
- **Без Default Prompt:** Пользователь вводит промпт вручную → Claude отвечает → `.jsonl` создан → Sniper ловит → переход из "Ожидание" в "Активная".
- **History Restore:** `claudeSessionId` берётся из БД (Immediate Injection), Sniper не нужен.

## Результат
Пользователь всегда видит корректный статус: AI запущен, но ID ещё не захвачен — жёлтый индикатор с пульсом.
