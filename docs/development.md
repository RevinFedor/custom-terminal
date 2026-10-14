# Разработка и вклад

Electron28.3.3, React19, Vite, Zustand, xterm.js, SQLite. Основной PTY-путь читает
native Claude JSONL/Codex rollout; SDK/legacy Gemini имеют отдельные runtime.

| Область | Source |
|---|---|
| PTY, process/input ownership, common actions | `src/main/main.js`, sibling modules |
| REST/SSE и external Inbox | `src/main/web-server.js` |
| History/Timeline и composer | `src/renderer/components/Workspace/`, `components/ComposerEditor.tsx` |
| Transcript read/rewrite | `src/main/ipc/claude-data.js`, `codex-data.js` и shared services |
| MCP wrapper | `mcp/terminal-server.mjs` |
| Shared DnD/file explorer | `vendor/noted-shared` |
| Shared editor | `vendor/markdown-editor` |
| Portable conversation rendering | `packages/claude-blocks` |

This checkout bundles the source dependencies rather than assuming a sibling
checkout. React/CodeMirror identity must stay coherent. The native drag compiler
is an explicit source script in `scripts/`, not a missing file under ignored `build/`.
Native modules are prepared for the pinned Electron ABI; node-pty's exact-source
patch keeps its exit-owner guard and is applied only to compiler scratch.

```bash
npm ci
npm run rebuild:native
npm run build:renderer
npm run test:setup
```

`test:setup` tests the changed setup/publication boundaries using temporary files
and substituted rebuild/process participants. Other unit/UI tests remain in the
source, but some historical regression helpers require explicit local fixtures
or a running private Electron test host; they are not all a promised portable
one-command suite. Captured user incident JSON and private worklogs are excluded.

For contributions, describe the user trigger, resulting behavior and validation.
Use synthetic fixtures and do not commit databases, auth/config, transcripts,
captures, private docs or generated bundles. Do not run provider inference as a
build/test side-effect. Keep provider capability differences and background behavior.
Do not replace common services with a second runner or relax unknown-delivery guards.

The original commit history is retained with sensitive file contents removed.
Future updates should extend this cleaned main; do not merge an old unsanitized
clone or private backup refs into it. Dependencies retain their own licenses; project code is MIT. See
[notices](../THIRD_PARTY_NOTICES.md) and [verification](verification.md).
