export function focusAndSelectInlineName(input) {
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}
