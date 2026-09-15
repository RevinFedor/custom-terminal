export function resolveUsageAccountPresentation(accounts, selectedAccountKey, currentAccountKey) {
  const rows = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const current = (currentAccountKey
    ? rows.find((account) => account.accountKey === currentAccountKey)
    : null)
    || rows.find((account) => account.isCurrent)
    || null;
  const selected = (selectedAccountKey
    ? rows.find((account) => account.accountKey === selectedAccountKey)
    : null)
    || current
    || rows[0]
    || null;

  return {
    selected,
    // The toolbar face reports the login used by an ordinary local CLI launch.
    // Inspecting another saved/managed account inside the popover must not
    // silently change that always-visible status surface.
    compact: current,
  };
}
