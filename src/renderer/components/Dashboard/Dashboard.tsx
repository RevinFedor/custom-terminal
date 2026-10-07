import React, { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import StorageBrowser from './StorageBrowser';
import './Home.css';

// Organization is independent of execution/project namespaces. The shared
// store supplies this command; Home never opens a project or asks for a path.
export default function Dashboard() {
  const spaces = useWorkspaceStore((state) => state.spaces);
  const addWorkspaceSpace = useWorkspaceStore((state) => state.addWorkspaceSpace);
  const hasUserWorkflow = spaces.some((space) => (space as typeof space & { kind?: string }).kind !== 'inbox');
  const pendingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createWorkflow = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const id = await addWorkspaceSpace({ activate: true });
      if (!id) setError('Could not create workflow. Try again.');
    } catch {
      setError('Could not create workflow. Try again.');
    } finally {
      pendingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div data-dashboard-root className="home-dashboard">
      <div className="home-content">
        <header className="home-welcome" data-home-empty={hasUserWorkflow ? 'false' : 'true'}>
          <div className="home-welcome-copy">
            <h1>{hasUserWorkflow ? 'Home' : 'Create your first workflow'}</h1>
            <p>{hasUserWorkflow
              ? 'Organize tabs and windows in workflows. Each tab keeps its own working directory.'
              : 'A workflow groups your tabs and windows. Start with one and arrange it as you work.'}</p>
          </div>
          <button type="button" data-home-create-workflow onClick={() => void createWorkflow()} disabled={creating}>
            <Plus size={16} /> {creating ? 'Creating…' : 'Create workflow'}
          </button>
          {error && <p className="home-create-error" role="alert">{error}</p>}
        </header>
        <StorageBrowser />
      </div>
    </div>
  );
}
