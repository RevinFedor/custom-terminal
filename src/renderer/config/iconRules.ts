// Правила для автоматического назначения иконок по расширениям файлов.
// Проверяются в порядке очереди. Первое совпадение выигрывает.

export interface IconRule {
  ext: string;
  icon: string;
}

export const ICON_RULES: IconRule[] = [
  // AI Бренды (по расширениям)
  { ext: '.gemini.md', icon: 'gemini' },
  { ext: '.google.md', icon: 'gemini' },
  { ext: '.claude.md', icon: 'claude' },
  { ext: '.anthropic.md', icon: 'claude' },
  { ext: '.openai.md', icon: 'openai' },
  { ext: '.gpt.md', icon: 'openai' },
  { ext: '.meta.md', icon: 'meta' },
  { ext: '.llama.md', icon: 'meta' },

  // Специфичные типы промптов
  { ext: '.prompt.md', icon: 'claude' },
  { ext: '.meta-prompt.md', icon: 'meta' },
  { ext: '.system.md', icon: 'gear' },
  { ext: '.thinking.md', icon: 'brain' },

  // Важные пометки
  { ext: '.fire.md', icon: 'fire' },
  { ext: '.star.md', icon: 'star' },
];
