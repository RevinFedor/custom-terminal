'use strict';

function formatSlashCommandDisplay(name, args = '') {
  const cleanName = String(name || '').trim().replace(/^\/+/, '');
  if (!cleanName) return null;
  const cleanArgs = String(args || '').trim();
  return '/' + cleanName + (cleanArgs ? ' ' + cleanArgs : '');
}

function slashCommandDisplayFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('<command-name>')) return null;
  const name = (trimmed.match(/<command-name>([^<]+)<\/command-name>/)?.[1] || '').trim();
  const args = (trimmed.match(/<command-args>([^<]*)/)?.[1] || '').trim();
  const content = formatSlashCommandDisplay(name, args);
  return content ? { content, name, args } : null;
}

function claudeSettingsServiceDisplayFromRecord(record) {
  if (record?.type !== 'user' || !record.uuid) return null;
  const body = record.message?.content;
  const text = typeof body === 'string' ? body : Array.isArray(body)
    ? body.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('\n') : '';
  const command = slashCommandDisplayFromText(text);
  return command && /^\/(model|effort)(?:\s|$)/.test(command.content) ? command : null;
}

module.exports = { formatSlashCommandDisplay, slashCommandDisplayFromText, claudeSettingsServiceDisplayFromRecord };
