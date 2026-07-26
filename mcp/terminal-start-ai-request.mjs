export function buildStartAiRequest(args, target, sourceMeta) {
  return {
    tabId: args.tabId,
    agent: args.agent,
    sessionId: args.sessionId || undefined,
    mode: args.mode || undefined,
    // target.cwd selects the Noted Terminal instance for HTTP routing. It is
    // not the live tab cwd. Omitting an explicit override lets Electron main
    // use terminalProjects.get(tabId), which tracks shell `cd` changes.
    cwd: args.cwd || undefined,
    model: args.model || undefined,
    effort: args.effort || undefined,
    parentProjectId: target.projectId || undefined,
    sourceMeta,
  };
}
