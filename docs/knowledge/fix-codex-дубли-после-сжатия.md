# Fix: Codex export duplicated prompts after compact

## Symptoms
- Full Codex Copy Session export could show the same prompt multiple times.
- The duplication got worse in transcripts with several compaction points: later compacts re-emitted already existing prompts, so a copied `.md` looked like one prompt appeared several times.
- The export still looked structurally valid, so the bug was easy to miss until someone compared prompt counts or the selected range against the real rollout.

## Root cause
`buildCodexCleanEntries()` treated `record.type === 'compacted'` as a compact snapshot, but the old path also recursively expanded `payload.replacement_history`.

In Codex JSONL that field is the compacted model snapshot, not a new set of user-visible turns. Recursing through it on every compact re-materialized old prompts that were already present in the surrounding rollout records, so every later compact inflated the export again.

## Fix
For clean export, a top-level `compacted` record is now a single compact marker. It keeps the compact title/text, but it does not recurse into `replacement_history`.

Range copy keeps using the already-clean timeline and then filters by the selected `turnIndex` / compact UUID, so a deliberately trimmed start still omits earlier turns by design. That is selection scope, not missing data.

One explicit exception is context-menu `Copy compact`: Timeline calls `codex:copy-range` with `startUuid === endUuid` for a single compact marker. In that case the selected object is the compact snapshot itself, not a transcript range, so the backend expands that one `replacement_history`. Multi-entry ranges still keep compact markers shallow.

## Why this was non-obvious
`replacement_history` looks authoritative because it is verbose and complete. For export, though, the authoritative chronology is the rollout stream itself. The nested snapshot is useful for display and compact summaries, but not for replaying the transcript as if it were fresh turns.

The opposite regression is also possible: applying the marker-only rule everywhere makes `Copy compact` copy almost nothing (`Conversation compacted`) even when the original compact snapshot is 100KB+ of usable context.

## Развёрнутый compact — это вербатим, не пересказ (нет регрессии)
Когда `Copy compact` разворачивает `replacement_history`, пользователь получает **дословные** сообщения последних ходов плюс финальный маркер `[encrypted compaction state]` — а **не** прозаическое summary как у Claude. У Codex `replacement_history` хранит вербатим-ходы (`role: user/assistant/developer`) + одну зашифрованную капсулу `encrypted_content` (Fernet → `AES-128-CBC` + HMAC), которую нельзя расшифровать на клиенте: ключ у OpenAI, привязан к модели и ротируется. Пользовательский симптом «нажал *Копировать compact*, а там просто перечислены мои сообщения, никакого пересказа нет» — **ожидаемое поведение**, а не пустой/сломанный экспорт. Структура записи и причина невозможности расшифровки — в [`fact-codex.md`](fact-codex.md) (секция про `replacement_history`).
