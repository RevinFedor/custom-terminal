import { usePromptsStore } from '../store/usePromptsStore';
import { generateTitleFromPromptWithConfig } from './generateTabTitle';
import { TASK_THEME_PROMPT_ID, DEFAULT_TASK_THEME_PROMPT } from '../../shared/task-theme-prompt.mjs';

export async function generateTaskTheme(body: string): Promise<{ shortTitle: string; title: string }> {
  if (!usePromptsStore.getState().isLoaded) await usePromptsStore.getState().loadPrompts();
  const config = usePromptsStore.getState().getPromptById(TASK_THEME_PROMPT_ID);
  const raw = await generateTitleFromPromptWithConfig(body, config, {
    fallbackPrompt: DEFAULT_TASK_THEME_PROMPT, sourceLabel: 'Исходный текст отложенной задачи',
    logPrefix: 'TaskTheme', taskType: TASK_THEME_PROMPT_ID, promptId: TASK_THEME_PROMPT_ID,
    sanitize: text => text.trim(),
  });
  if (!raw) throw new Error('AI не вернул название задачи');
  const value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (typeof value.shortTitle !== 'string' || !value.shortTitle.trim()
    || typeof value.title !== 'string' || !value.title.trim()) throw new Error('AI вернул неверный формат задачи');
  return { shortTitle: value.shortTitle.replace(/\s+/g, ' ').trim().slice(0, 48),
    title: value.title.replace(/\s+/g, ' ').trim().slice(0, 500) };
}
