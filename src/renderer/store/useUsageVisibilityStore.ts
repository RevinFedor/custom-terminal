import { create } from 'zustand';

type UsageProvider = 'codex' | 'claude';
type VisibleProviders = Record<UsageProvider, boolean>;
const STORAGE_KEY = 'noted-terminal-usage-visible-providers';

function readVisibility(): VisibleProviders {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return { codex: saved?.codex !== false, claude: saved?.claude !== false };
  } catch { return { codex: true, claude: true }; }
}

export const useUsageVisibilityStore = create<{
  visibleProviders: VisibleProviders;
  toggleProvider: (provider: UsageProvider) => void;
}>((set, get) => ({
  visibleProviders: readVisibility(),
  toggleProvider: provider => {
    const previous = get().visibleProviders;
    const next = { ...previous, [provider]: !previous[provider] };
    set({ visibleProviders: next });
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) useUsageVisibilityStore.setState({ visibleProviders: readVisibility() });
  });
}
