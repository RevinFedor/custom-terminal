import { normalizeTerminalMessageSnapshot, readTerminalMessageClipboard, terminalMessageLabel } from '../../shared/terminal-message-reference.mjs';
export { readTerminalMessageClipboard, terminalMessageLabel };
export const terminalMessageChipSnapshot = chip => normalizeTerminalMessageSnapshot(chip?.messageReference, chip?.text);
export function terminalMessageTokenPresentation(chip, ordinaryLabel) {
  const snapshot = terminalMessageChipSnapshot(chip);
  return snapshot ? { label: terminalMessageLabel(snapshot), messageReference: snapshot } : { label: ordinaryLabel };
}
