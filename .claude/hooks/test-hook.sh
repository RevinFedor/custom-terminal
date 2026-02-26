#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

if [ -z "$PROMPT" ] || ! echo "$PROMPT" | grep -q "ttt"; then
  exit 0
fi

# Тест 1: ttt1 — мгновенный (уже работает)
# Тест 2: ttt2 — задержка 20 секунд
# Тест 3: ttt3 — большой output (50KB)
# Тест 4: ttt4 — subprocess (claude -p)

if echo "$PROMPT" | grep -q "ttt1"; then
  echo "[TEST 1] Instant hook output works"
  exit 0
fi

if echo "$PROMPT" | grep -q "ttt2"; then
  sleep 20
  echo "[TEST 2] Delayed hook output (20s) works"
  exit 0
fi

if echo "$PROMPT" | grep -q "ttt3"; then
  echo "[TEST 3] Large output test"
  # Генерируем ~50KB текста
  for i in $(seq 1 500); do
    echo "Line $i: This is padding text to test large hook output. Lorem ipsum dolor sit amet consectetur."
  done
  exit 0
fi

if echo "$PROMPT" | grep -q "ttt4"; then
  # Имитируем паттерн semantic-router: вызов claude -p
  RESULT=$(echo "Reply with exactly: SUBPROCESS_OK" | env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p \
    --model haiku \
    --no-session-persistence \
    2>/dev/null) || true
  echo "[TEST 4] Subprocess result: $RESULT"
  exit 0
fi

echo "[TEST] Unknown test variant. Use ttt1, ttt2, ttt3, or ttt4"
exit 0
