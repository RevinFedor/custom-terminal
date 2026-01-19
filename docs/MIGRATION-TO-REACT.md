# Migration to React - Strategy & Plan

**Date:** 2026-01-19
**Decision:** YES, migrate to React (Hybrid Approach)
**Status:** Proposal

---

## Why Migrate?

### Current Problems (Vanilla JS)

1. **Unmanageable State (3012 lines)**
   - `renderer.js` hit critical mass
   - Global state scattered across file:
     ```javascript
     let activeProjectId = null;
     const openProjects = new Map();
     let dashboardSelectedProject = null;
     let isRenamingTab = false;
     ```
   - Any state change = manual DOM updates in 10 places

2. **Tab Switching Nightmare**
   - Developer quote: "задолбался с переключением вкладок"
   - Imperative code: find element → remove class → find another → add class → hide → show...
   - Hard to debug, hard to maintain

3. **Future: Agent Orchestrator**
   - Drag-and-drop agents
   - Real-time status updates
   - CPU/memory graphs
   - Complex forms
   - **On Vanilla JS = 10,000+ lines of spaghetti code**

4. **No Component Reuse**
   - Button code duplicated everywhere
   - Session cards copy-pasted
   - Any change = update 10 places

### Why React Won't Kill Performance

**Myth:** "React is heavy for Electron"

**Reality:**
- React bundle: ~40KB minified (+ ~30KB ReactDOM)
- Electron already ships Chromium: **100MB+**
- 70KB is **0.07%** of Chromium size
- Virtual DOM is FASTER than bad Vanilla JS

**Proof:**
- VS Code uses component architecture (custom framework, but same principles)
- Hyper Terminal: React + Electron
- Warp Terminal: Rust backend + complex UI (React-like components)

**xterm.js + React:**
```jsx
// Simple wrapper
const TerminalTab = ({ tabId, active }) => {
  const terminalRef = useRef(null);
  const xtermInstance = useRef(null);

  useEffect(() => {
    // Initialize once
    xtermInstance.current = new Terminal();
    xtermInstance.current.open(terminalRef.current);

    return () => xtermInstance.current.dispose();
  }, []);

  // Hide with CSS, not unmount (preserves buffer)
  return <div ref={terminalRef} className={active ? 'block' : 'hidden'} />;
};
```

No performance issues. xterm.js works with real DOM, React never touches it.

---

## Migration Strategy: Hybrid Approach

**DON'T:** Rewrite everything at once (risky, time-consuming)

**DO:** Gradual migration in 3 phases

### Phase 1: Setup React Infrastructure (Week 1)

**Goal:** Get React working alongside Vanilla JS

**Tasks:**
1. Install dependencies:
   ```bash
   npm install react react-dom
   npm install -D vite @vitejs/plugin-react
   ```

2. Setup Vite (electron-vite boilerplate):
   ```bash
   npm install -D electron-vite
   ```

3. Create entry point: `src/renderer/main.tsx`

4. Keep `renderer.js` intact, mount React in a separate container:
   ```jsx
   // src/renderer/App.tsx
   import { Dashboard } from './components/Dashboard';

   function App() {
     return (
       <div id="react-root">
         {/* New React components render here */}
       </div>
     );
   }
   ```

5. Update `index.html`:
   ```html
   <div id="app"></div> <!-- React mounts here -->
   <script src="renderer.js"></script> <!-- Legacy code still works -->
   ```

**Result:** Both Vanilla JS and React coexist. No breaking changes.

---

### Phase 2: Migrate Dashboard First (Week 2-3)

**Why Dashboard first?**
- Self-contained (no xterm.js complexity)
- Most visible UI (user sees improvements immediately)
- Good learning ground for team

**Components to build:**
```
Dashboard/
  ├── DashboardNav.tsx       (Projects/Settings tabs)
  ├── ProjectsGrid.tsx       (Card grid)
  ├── ProjectCard.tsx        (Reusable card)
  ├── SettingsPanel.tsx      (Commands + Prompts)
  └── CommandEditor.tsx      (Add/edit commands)
```

**State Management:**
```typescript
// store/useProjects.ts (Zustand)
interface ProjectsStore {
  projects: Project[];
  selectedProject: Project | null;
  loadProjects: () => Promise<void>;
  openProject: (id: string) => void;
}

export const useProjects = create<ProjectsStore>((set) => ({
  projects: [],
  selectedProject: null,
  loadProjects: async () => {
    const projects = await ipcRenderer.invoke('project:list');
    set({ projects });
  },
  openProject: (id) => {
    // Trigger workspace view (still Vanilla JS for now)
    window.openProject(id);
  }
}));
```

**Bridge to Vanilla JS:**
```javascript
// renderer.js
window.openProject = function(projectId) {
  // Existing logic works
  switchToWorkspace(projectId);
};
```

**Result:** Beautiful React dashboard, legacy workspace still works.

---

### Phase 3: Migrate Workspace (Week 4-6)

**Components:**
```
Workspace/
  ├── ProjectChips.tsx       (Title bar chips)
  ├── TabBar.tsx             (Terminal tabs)
  ├── TerminalArea.tsx       (xterm.js wrapper)
  ├── Sidebar/
  │   ├── NotesPanel.tsx
  │   ├── AIPanel.tsx
  │   ├── ActionsPanel.tsx
  │   └── SessionsPanel.tsx
  └── FilePreview.tsx
```

**Critical: xterm.js wrapper:**
```tsx
// components/Terminal.tsx
interface TerminalProps {
  tabId: string;
  active: boolean;
  cwd: string;
}

export const Terminal: React.FC<TerminalProps> = ({ tabId, active, cwd }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerminal | null>(null);
  const fitAddon = useRef(new FitAddon());

  useEffect(() => {
    // Initialize xterm ONCE
    if (!xtermInstance.current) {
      const term = new XTerminal({
        theme: darkTheme,
        fontFamily: 'JetBrains Mono',
      });

      term.loadAddon(fitAddon.current);
      term.loadAddon(new WebglAddon());
      term.loadAddon(new SerializeAddon());
      term.open(terminalRef.current!);

      // IPC communication
      ipcRenderer.invoke('terminal:create', { tabId, cwd }).then(({ pid }) => {
        term.onData((data) => {
          ipcRenderer.send('terminal:input', tabId, data);
        });

        ipcRenderer.on('terminal:data', (_, { tabId: id, data }) => {
          if (id === tabId) term.write(data);
        });
      });

      xtermInstance.current = term;
    }

    return () => {
      // Cleanup only on unmount
      xtermInstance.current?.dispose();
    };
  }, []); // Empty deps = run once

  useEffect(() => {
    // Fit on resize
    if (active) {
      fitAddon.current.fit();
    }
  }, [active]);

  return (
    <div
      ref={terminalRef}
      className={`terminal-instance ${active ? 'block' : 'hidden'}`}
    />
  );
};
```

**State Management:**
```typescript
// store/useWorkspace.ts
interface WorkspaceStore {
  activeProjectId: string | null;
  projects: Map<string, ProjectState>;

  openProject: (id: string) => void;
  createTab: (projectId: string, name: string) => void;
  closeTab: (projectId: string, tabId: string) => void;
  switchTab: (projectId: string, tabId: string) => void;
}
```

**Result:** Fully reactive workspace. Tab switching = `setState(newTabId)`. Done.

---

### Phase 4: Agent Orchestrator (NEW Feature)

**Now you're ready for complex UI:**

```tsx
// components/AgentOrchestrator/
├── AgentsList.tsx           (Drag-drop list)
├── AgentCard.tsx            (Status, controls)
├── AgentLogs.tsx            (Real-time logs)
├── ResourceMonitor.tsx      (CPU/Memory graphs)
└── AgentConfig.tsx          (Form with validation)
```

**With React:**
```tsx
const AgentCard = ({ agent }) => {
  const { startAgent, stopAgent } = useAgents();

  return (
    <div className={`agent-card ${agent.status}`}>
      <h3>{agent.name}</h3>
      <StatusBadge status={agent.status} />
      {agent.status === 'running' ? (
        <button onClick={() => stopAgent(agent.id)}>Stop</button>
      ) : (
        <button onClick={() => startAgent(agent.id)}>Start</button>
      )}
      <AgentLogs logs={agent.logs} />
    </div>
  );
};
```

**On Vanilla JS:**
```javascript
// 200 lines of DOM manipulation
function updateAgentCard(agentId) {
  const card = document.querySelector(`#agent-${agentId}`);
  const badge = card.querySelector('.status-badge');
  const button = card.querySelector('.control-btn');
  const logs = card.querySelector('.logs');
  // ... and 50 more lines
}
```

---

## Tech Stack

### Frontend
- **React 19** (latest stable)
- **Vite** (fast bundler, better than Webpack)
- **Zustand** (state management, simpler than Redux)
- **Tailwind CSS v4** (already using, keep it)

### Backend (unchanged)
- **Electron 28**
- **Node.js + node-pty**
- **better-sqlite3**

### Build
- **electron-vite** (official Electron + Vite integration)
  ```bash
  npm create @quick-start/electron -- noted-terminal-react
  ```

---

## File Structure (After Migration)

```
noted-terminal/
├── src/
│   ├── main/              (Electron main process, unchanged)
│   │   ├── main.js
│   │   ├── database.js
│   │   ├── session-manager.js
│   │   └── project-manager.js
│   │
│   └── renderer/          (React frontend)
│       ├── main.tsx       (Entry point)
│       ├── App.tsx        (Root component)
│       ├── components/
│       │   ├── Dashboard/
│       │   ├── Workspace/
│       │   └── AgentOrchestrator/
│       ├── store/         (Zustand stores)
│       │   ├── useProjects.ts
│       │   ├── useWorkspace.ts
│       │   └── useAgents.ts
│       └── styles/
│           └── globals.css (Tailwind input)
│
├── docs/                  (Unchanged)
├── build-resources/       (Unchanged)
└── package.json
```

---

## Risks & Mitigation

### Risk 1: Breaking Existing Features
**Mitigation:** Hybrid approach. Keep Vanilla JS running alongside React until fully migrated.

### Risk 2: xterm.js Integration Issues
**Mitigation:** Use `useRef` + `useEffect`, never let React re-render terminal div.

### Risk 3: Learning Curve
**Mitigation:** Start with simple Dashboard. Use TypeScript for better DX.

### Risk 4: Build Complexity
**Mitigation:** Use `electron-vite` boilerplate. Pre-configured for Electron + React.

---

## Benefits Summary

### Before (Vanilla JS):
- ❌ 3012 lines in one file
- ❌ Global state chaos
- ❌ Manual DOM updates everywhere
- ❌ Hard to debug tab switching
- ❌ No component reuse
- ❌ Future Orchestrator = nightmare

### After (React):
- ✅ Components: `<TerminalTab />`, `<ProjectCard />`, `<AgentCard />`
- ✅ State management: Zustand (one source of truth)
- ✅ Declarative: `{active && <Terminal />}`
- ✅ Reusable: Same button component everywhere
- ✅ Scalable: Add Orchestrator without pain
- ✅ Developer experience: TypeScript, hot reload, React DevTools

---

## Timeline

**Week 1:** Setup React + Vite (hybrid mode)
**Week 2-3:** Migrate Dashboard
**Week 4-6:** Migrate Workspace
**Week 7+:** Build Agent Orchestrator (NEW)

**Total:** ~6 weeks to fully migrate existing features.

---

## Decision

**Verdict:** MIGRATE to React

**Approach:** Hybrid (gradual)

**Next Steps:**
1. Create new branch: `feat/react-migration`
2. Setup electron-vite boilerplate
3. Start with Dashboard migration
4. Test thoroughly before merging

---

## Resources

- [electron-vite docs](https://electron-vite.org/)
- [Zustand docs](https://zustand-demo.pmnd.rs/)
- [xterm.js + React example](https://github.com/xtermjs/xterm.js/issues/2495)
- [Tailwind v4 with Vite](https://tailwindcss.com/docs/v4-beta)

---

**Author:** Claude Code
**Reviewed by:** Fedor (project owner)
**Status:** Awaiting approval
