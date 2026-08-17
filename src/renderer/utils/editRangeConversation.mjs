export function buildInitialEditRangeMessages(initialCompact) {
  const compact = String(initialCompact || '');
  return compact.trim()
    ? [{ id: 'initial', role: 'assistant', content: compact }]
    : [];
}

export function buildEditRangeSubmission({
  sourceContent,
  messages,
  inputValue,
  promptDraftMode,
  now = Date.now(),
}) {
  const content = String(inputValue || '').trim();
  if (!content) throw new Error('Edit Range prompt is empty');

  const isPromptDraftFirstSend = promptDraftMode === true && messages.length === 0;
  const userMessage = {
    id: `user-${now}`,
    role: 'user',
    content,
    ...(isPromptDraftFirstSend
      ? { apiContent: `${content}\n\n${sourceContent}` }
      : {}),
  };
  const conversation = promptDraftMode === true
    ? [...messages, userMessage]
    : [
        { id: 'source', role: 'user', content: sourceContent },
        ...messages,
        userMessage,
      ];
  const contents = conversation.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.apiContent || message.content }],
  }));

  return { userMessage, contents };
}
