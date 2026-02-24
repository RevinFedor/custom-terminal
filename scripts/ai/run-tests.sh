#!/bin/bash
# =============================================================================
# Semantic Router Test Runner
# Прогоняет тестовые промпты через хук и показывает только выбранные файлы
#
# Запуск: bash scripts/ai/run-tests.sh
# =============================================================================

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$PROJECT_DIR/.claude/hooks/semantic-router.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ ! -f "$HOOK" ]; then
  echo -e "${RED}ERROR: semantic-router.sh not found${NC}"
  exit 1
fi

if [ ! -f "$PROJECT_DIR/.semantic-index.json" ]; then
  echo -e "${RED}ERROR: .semantic-index.json not found. Run: bash scripts/ai/build-index.sh${NC}"
  exit 1
fi

# Тестовые промпты: "НАЗВАНИЕ|ПРОМПТ|ОЖИДАЕМЫЕ ФАЙЛЫ (через запятую)"
TESTS=(
  # TIER 2 — двойные implicit связи
  "Мусор при переключении|При переключении между проектами терминал иногда показывает мусор вместо текста ???|ui-terminal-rendering.md,terminal-core.md"
  "Зеленая точка моргает|Почему при быстром переключении вкладок зеленая точка running моргает и пропадает ???|ui-react-patterns.md,terminal-core.md"
  "Zustand ре-рендеры|Zustand store обновляется каждые 2 секунды — не вызывает ли это лишних ре-рендеров ???|fix-zustand-silent-mutation.md"

  # TIER 3 — цепочки 3+ файлов
  "Rewind Enter|Rewind в Timeline вставляет текст но Enter не срабатывает и текст не отправляется ???|fix-rewind-navigation.md,terminal-core.md,fact-claude-tui-mechanics.md"
  "Compact красные|После /compact в Claude часть сообщений в Timeline показывается красным — почему ???|ai-backtrace-jsonl.md,timeline.md"
  "Ctrl+C model crash|Claude вышел после переключения модели — я нажал Ctrl+C перед /model ???|fix-claude-ctrlc-exit.md,fact-claude-tui-control.md"

  # TIER 4 — стресс (3 рукопожатия, implicit-only)
  "Шрифт + перенос строк|Шрифт загружается с задержкой и после этого Claude перестает нормально переносить строки ???|ui-css-layout.md,terminal-core.md"
  "Plan Mode + Fork export|Timeline не показывает plan mode маркеры в форкнутой сессии хотя в оригинале они были ???|ai-backtrace-jsonl.md,timeline.md,fix-claude-plan-mode-chain.md"
  "Handshake paste broken|Вставка через Cmd+V работает но автоматическая отправка промпта при старте Handshake ломает текст ???|terminal-core.md,fact-claude-tui-control.md,fact-claude-tui-mechanics.md"
  "Paste 30s freeze|Когда я вставляю длинный промпт в Claude через Ctrl+V терминал зависает на 30 секунд ???|terminal-core.md,fact-claude-tui-mechanics.md"

  # TIER 5 — Opus chains (максимальная сложность)
  "Range copy empty|Копирование диапазона сообщений из Timeline иногда возвращает пустые данные ???|timeline.md,fix-zustand-silent-mutation.md,ui-react-patterns.md"
  "Tab names reset|После перезапуска приложения переименованные Claude табы теряют имена и становятся claude-01 ???|data-persistence.md,fix-zustand-silent-mutation.md"
  "Restart button gone|Есть таб с dev-server и зеленой кнопкой restart. Создаю новый таб через Cmd+T и кнопка restart на старом табе исчезает ???|terminal-core.md,scripts.md"
  "Notes scroll broken|Редактор заметок в InfoPanel не имеет скроллбара хотя тот же MarkdownEditor работает в FilePreview ???|ui-css-layout.md,file-preview-markdown.md,rendering-styles.md"
  "Research no search|Правый клик по тексту в терминале Research Selection — панель открывается но поиск не запускается ???|fix-research-activation.md,terminal-core.md,research.md"
)

TOTAL=${#TESTS[@]}
PASS=0
PARTIAL=0
FAIL=0

echo -e "${BLUE}=== Semantic Router Test Suite ===${NC}"
echo -e "${BLUE}Tests: $TOTAL | Index: $(jq 'length' "$PROJECT_DIR/.semantic-index.json") files${NC}"
echo ""

for i in "${!TESTS[@]}"; do
  IFS='|' read -r NAME PROMPT EXPECTED <<< "${TESTS[$i]}"
  NUM=$((i + 1))

  # Запускаем хук
  START_TIME=$(date +%s)
  RESULT=$(echo "{\"prompt\": \"$PROMPT\"}" | CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash "$HOOK" 2>/dev/null | head -1)
  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))

  # Извлекаем выбранные файлы
  SELECTED=$(echo "$RESULT" | sed 's/.*Haiku selected: //' | tr -d ' ')

  # Считаем совпадения
  HIT=0
  MISS=0
  EXPECTED_LIST=""
  IFS=',' read -ra EXP_ARR <<< "$EXPECTED"
  for exp in "${EXP_ARR[@]}"; do
    if echo "$SELECTED" | grep -qi "$exp"; then
      HIT=$((HIT + 1))
      EXPECTED_LIST="${EXPECTED_LIST} ${GREEN}${exp}${NC}"
    else
      MISS=$((MISS + 1))
      EXPECTED_LIST="${EXPECTED_LIST} ${RED}${exp}${NC}"
    fi
  done

  TOTAL_EXPECTED=${#EXP_ARR[@]}

  # Статус
  if [ "$HIT" -eq "$TOTAL_EXPECTED" ]; then
    STATUS="${GREEN}PASS${NC}"
    PASS=$((PASS + 1))
  elif [ "$HIT" -gt 0 ]; then
    STATUS="${YELLOW}PARTIAL${NC}"
    PARTIAL=$((PARTIAL + 1))
  else
    STATUS="${RED}FAIL${NC}"
    FAIL=$((FAIL + 1))
  fi

  echo -e "${BLUE}[$NUM/$TOTAL]${NC} $NAME [${ELAPSED}s]"
  echo -e "  Status: $STATUS ($HIT/$TOTAL_EXPECTED)"
  echo -e "  Expected:$EXPECTED_LIST"
  echo -e "  Got: ${CYAN}$SELECTED${NC}"
  echo ""
done

# Итоги
echo -e "${BLUE}========================================${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}  ${YELLOW}PARTIAL: $PARTIAL${NC}  ${RED}FAIL: $FAIL${NC}  Total: $TOTAL"
SCORE=$((PASS * 100 / TOTAL))
if [ "$SCORE" -ge 70 ]; then
  echo -e "  Score: ${GREEN}${SCORE}%${NC}"
elif [ "$SCORE" -ge 40 ]; then
  echo -e "  Score: ${YELLOW}${SCORE}%${NC}"
else
  echo -e "  Score: ${RED}${SCORE}%${NC}"
fi
echo -e "${BLUE}========================================${NC}"
