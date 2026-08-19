/**
 * Provider-neutral Copy Session contract.
 *
 * The renderer used to send Claude/Codex transport buckets (Bash,
 * apply_patch, tool_search). The main process then had to guess a different
 * meaning for each provider. These fields name user-visible ACTIONS instead;
 * both exporters resolve their raw calls through the same action grammar.
 */
export interface CopySessionFilters {
  includeUser: boolean;
  includeClaude: boolean;
  includeText: boolean;
  includeThinking: boolean;
  includeActions: boolean;
  includeReading: boolean;
  includeSearch: boolean;
  includeEditing: boolean;
  includeRun: boolean;
  includeGit: boolean;
  includeMcp: boolean;
  includeWeb: boolean;
  includePlan: boolean;
  includeOther: boolean;
  includeSubagentResult: boolean;
  includeSubagentHistory: boolean;
  fromStart: boolean;

  // Transitional aliases for a renderer/main version skew during HMR. New
  // code does not classify by them; an older main process still receives the
  // closest safe approximation until the required app restart.
  includeBash: boolean;
  includeTools: boolean;
  includeWebSearch: boolean;
  includeToolSearch: boolean;
  includeOtherTools: boolean;
}

type CopySettingsState = {
  copyIncludeUser: boolean;
  copyIncludeText: boolean;
  copyIncludeThinking: boolean;
  copyIncludeActions?: boolean;
  copyIncludeReading: boolean;
  copyIncludeSearch?: boolean;
  copyIncludeEditing: boolean;
  copyIncludeRun?: boolean;
  copyIncludeGit?: boolean;
  copyIncludeMcp?: boolean;
  copyIncludeWebSearch: boolean;
  copyIncludePlan?: boolean;
  copyIncludeOtherTools: boolean;
  copyIncludeSubagentResult: boolean;
  copyIncludeSubagentHistory: boolean;
  copyFromStart: boolean;
  copyIncludeClaude?: boolean;
  copyIncludeBash?: boolean;
  copyIncludeTools?: boolean;
  copyIncludeToolSearch?: boolean;
};

export const copySessionFiltersFromState = (state: CopySettingsState): CopySessionFilters => {
  const includeActions = !!(state.copyIncludeActions ?? state.copyIncludeClaude ?? true);
  const includeSubagentResult = includeActions && !!state.copyIncludeSubagentResult;
  const includeSubagentHistory = includeActions && !!state.copyIncludeSubagentHistory;
  const includeClaude = !!state.copyIncludeText
    || !!state.copyIncludeThinking
    || includeActions;

  return {
    includeUser: !!state.copyIncludeUser,
    includeClaude,
    includeText: !!state.copyIncludeText,
    includeThinking: !!state.copyIncludeThinking,
    includeActions,
    includeReading: !!state.copyIncludeReading,
    includeSearch: !!(state.copyIncludeSearch ?? state.copyIncludeBash),
    includeEditing: !!state.copyIncludeEditing,
    includeRun: !!(state.copyIncludeRun ?? state.copyIncludeBash),
    includeGit: !!(state.copyIncludeGit ?? state.copyIncludeBash),
    includeMcp: !!(state.copyIncludeMcp ?? state.copyIncludeTools),
    includeWeb: !!state.copyIncludeWebSearch,
    includePlan: !!(state.copyIncludePlan ?? state.copyIncludeToolSearch ?? state.copyIncludeOtherTools),
    includeOther: !!state.copyIncludeOtherTools,
    includeSubagentResult,
    includeSubagentHistory,
    fromStart: !!state.copyFromStart,

    includeBash: !!((state.copyIncludeRun ?? state.copyIncludeBash)
      || (state.copyIncludeSearch ?? state.copyIncludeBash)
      || (state.copyIncludeGit ?? state.copyIncludeBash)),
    includeTools: !!(state.copyIncludeMcp ?? state.copyIncludeTools),
    includeWebSearch: !!state.copyIncludeWebSearch,
    includeToolSearch: !!(state.copyIncludePlan ?? state.copyIncludeToolSearch),
    includeOtherTools: !!state.copyIncludeOtherTools,
  };
};
