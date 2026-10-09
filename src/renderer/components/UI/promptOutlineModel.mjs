// Canonical implementation shared with Main's read-only prompt library API.
// Keep this import path stable for Settings, Picker and existing tests.
import outline from '../../../shared/prompt-outline.cjs';
export const { promptOutlineGroupId, promptOutlinePromptId, buildPromptOutline, applyPromptOutline, promptOutlineHorizontalPolicy, promptOutlineVerticalSlotPolicy } = outline;
