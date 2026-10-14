# Source and dependency notices

Project-owned source is distributed under [MIT](LICENSE), matching the original
repository's stated MIT license. The bundled reusable packages `noted-shared`,
`@gt-editor/markdown-editor` and `@noted/claude-blocks` are source components from
the same maintainer and carry that license text. Their inclusion is limited to
library source required by Noted; it does not distribute the other applications.

External Node packages installed by `npm ci` retain their own licenses. Important
runtime/build dependencies include Electron (MIT), React (MIT), xterm.js (MIT),
better-sqlite3 (MIT), node-pty (MIT), CodeMirror (MIT), Vite (MIT), Tailwind CSS (MIT),
Zustand (MIT), Koffi (MIT), and provider SDKs under their package licenses. The
lockfile fixes package artifacts; package license texts remain in installed modules.
Dependencies are not relicensed by this repository. Review them for your use case.

The node-pty packaging script applies a bounded patch to the installed MIT upstream
source only in scratch; upstream copyright/license stays with the dependency.
No decompiled Claude Code source, Claude/Codex binary, personal certificate/private
key, user database or private runtime configuration is distributed in the public tree.
Provider trademarks refer to integration targets and do not imply endorsement.

JetBrains Mono Nerd Font is included under its embedded SIL OFL1.1 grant. Copyright
2020 The JetBrains Mono Project Authors; Nerd Fonts supplies the patched glyphs.
The font license texts are in `src/renderer/assets/fonts/`; upstream projects:
https://github.com/JetBrains/JetBrainsMono and https://github.com/ryanoasis/nerd-fonts.

## Direct dependency license metadata

This is package-declared metadata, not a replacement for its license text.

| Package | Version | License metadata |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.156 | SEE LICENSE IN README.md |
| `@assistant-ui/react` | 0.12.24 | MIT |
| `@atlaskit/pragmatic-drag-and-drop` | 1.7.7 | Apache-2.0 |
| `@atlaskit/pragmatic-drag-and-drop-auto-scroll` | 2.1.5 | Apache-2.0 |
| `@atlaskit/pragmatic-drag-and-drop-hitbox` | 1.1.0 | Apache-2.0 |
| `@babel/parser` | 7.29.3 | MIT |
| `@google/genai` | 1.38.0 | Apache-2.0 |
| `@gt-editor/markdown-editor` | 0.1.1 | MIT |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT |
| `@radix-ui/react-dialog` | 1.1.15 | MIT |
| `@tailwindcss/typography` | 0.5.19 | MIT |
| `@types/react-syntax-highlighter` | 15.5.13 | MIT |
| `@xterm/addon-fit` | 0.10.0 | MIT |
| `@xterm/addon-search` | 0.16.0 | MIT |
| `@xterm/addon-serialize` | 0.14.0 | MIT |
| `@xterm/addon-web-links` | 0.11.0 | MIT |
| `@xterm/addon-webgl` | 0.19.0 | MIT |
| `@xterm/headless` | 6.0.0 | MIT |
| `@xterm/xterm` | 5.5.0 | MIT |
| `better-sqlite3` | 12.6.2 | MIT |
| `debug` | 4.4.3 | MIT |
| `framer-motion` | 12.27.5 | MIT |
| `highlight.js` | 11.11.1 | BSD-3-Clause |
| `idb` | 8.0.3 | ISC |
| `koffi` | 3.1.2 | MIT |
| `lucide-react` | 0.562.0 | ISC |
| `node-pty` | 1.2.0-beta.13 | MIT |
| `react` | 19.2.3 | MIT |
| `react-colorful` | 5.7.0 | MIT |
| `react-dom` | 19.2.3 | MIT |
| `react-icons` | 5.5.0 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `react-syntax-highlighter` | 16.1.0 | MIT |
| `react-virtuoso` | 4.18.7 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `virtua` | 0.48.6 | MIT |
| `ws` | 8.20.1 | MIT |
| `zustand` | 5.0.12 | MIT |

In particular, Claude Agent SDK declares `SEE LICENSE IN README.md`; consult
its own SDK/Claude Code terms. The project MIT grant does not relicense it.
