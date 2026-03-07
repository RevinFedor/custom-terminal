const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// In-memory settings synced from renderer (via docs:sync-settings IPC)
let docsConfig = {
  docPrompt: {
    useFile: true,
    filePath: '',
    inlineContent: ''
  },
  apiSettings: {
    claudeModel: 'claude-sonnet-4.5',
    claudeThinking: 'HIGH',
    geminiModel: 'gemini-3-flash-preview',
    geminiThinking: 'HIGH'
  }
};

function getDocsConfig() {
  return docsConfig;
}

// ── Reusable API call functions (used by IPC handlers AND MCP HTTP endpoint) ──

async function callClaudeApi(system, prompt, model = 'claude-opus-4.6', thinking = 'HIGH') {
  try {
    console.log('[docs:claude-api] Sending ' + Math.round(prompt.length / 1024) + 'KB to Claude API, model=' + model + ' thinking=' + thinking);
    const body = {
      model,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (system) body.system = system;

    // Extended thinking support
    if (thinking && thinking !== 'NONE') {
      const budgetMap = { LOW: 5000, MEDIUM: 16000, HIGH: 50000 };
      const budgetTokens = budgetMap[thinking] || 50000;
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
      // max_tokens must be > budget_tokens
      if (body.max_tokens <= budgetTokens) {
        body.max_tokens = budgetTokens + 16000;
      }
    }

    const response = await fetch('https://api.kiro.cheap/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-aw-57742ca44f8b04d8fdd587f8289c7fb1',
        'anthropic-version': '2025-04-15',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('[docs:claude-api] API error ' + response.status + ' ' + errorText.slice(0, 300));
      return { success: false, error: 'API ' + response.status + ': ' + errorText.slice(0, 200) };
    }

    const data = await response.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock?.text) {
      return { success: false, error: 'No text block in API response' };
    }

    const usage = data.usage || {};
    console.log('[docs:claude-api] Response: ' + Math.round(textBlock.text.length / 1024) + 'KB, input: ' + usage.input_tokens + ' output: ' + usage.output_tokens);
    return { success: true, text: textBlock.text, usage };
  } catch (error) {
    console.error('[docs:claude-api] Error:', error);
    return { success: false, error: error.message };
  }
}

async function callGeminiApi(system, prompt, model = 'gemini-3-flash-preview', thinking = 'HIGH') {
  try {
    console.log('[docs:gemini-api] Sending ' + Math.round(prompt.length / 1024) + 'KB to Gemini API, model=' + model + ' thinking=' + thinking);

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
    };

    if (model.includes('gemini-3') && thinking !== 'NONE') {
      requestBody.generationConfig = {
        thinkingConfig: { thinkingLevel: thinking }
      };
    }

    const apiKey = 'REDACTED_GEMINI_KEY';
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    );

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error.message || 'Gemini API Error' };
    }

    if (!data.candidates?.[0]?.content?.parts) {
      return { success: false, error: 'Empty or blocked response' };
    }

    const textParts = data.candidates[0].content.parts.filter(p => !p.thought);
    const responseText = textParts.map(p => p.text).join('');

    const usage = data.usageMetadata || {};
    console.log('[docs:gemini-api] Response: ' + Math.round(responseText.length / 1024) + 'KB, input: ' + usage.promptTokenCount + ' output: ' + usage.candidatesTokenCount);
    return {
      success: true,
      text: responseText,
      usage: { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount }
    };
  } catch (error) {
    console.error('[docs:gemini-api] Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Call Gemini CLI in headless mode (-p flag).
 * Uses the full CLI system prompt + GEMINI.md context → better quality than raw API.
 * Prompt is passed via stdin to avoid shell escaping issues.
 */
async function callGeminiCli(system, prompt, model = 'gemini-3-flash-preview', cwd) {
  try {
    const fullPrompt = system ? system + '\n\n' + prompt : prompt;
    console.log('[docs:gemini-cli] Sending ' + Math.round(fullPrompt.length / 1024) + 'KB via CLI, model=' + model);

    // Write prompt to temp file (avoids shell arg length limits)
    const tmpFile = path.join(require('os').tmpdir(), 'gemini-cli-prompt-' + Date.now() + '.txt');
    fs.writeFileSync(tmpFile, fullPrompt, 'utf-8');

    return new Promise((resolve) => {
      const args = ['-p', '', '-m', model, '-o', 'json', '--approval-mode', 'plan'];
      const child = execFile('gemini', args, {
        cwd: cwd || process.cwd(),
        maxBuffer: 50 * 1024 * 1024, // 50MB
        timeout: 5 * 60 * 1000, // 5 min
        env: { ...process.env },
      }, (error, stdout, stderr) => {
        // Cleanup temp file
        try { fs.unlinkSync(tmpFile); } catch (_) {}

        if (error) {
          console.error('[docs:gemini-cli] Error:', error.message);
          return resolve({ success: false, error: error.message });
        }

        try {
          // stdout may have MCP warnings before JSON — find the JSON object
          const jsonStart = stdout.indexOf('{');
          if (jsonStart === -1) {
            return resolve({ success: false, error: 'No JSON in CLI output' });
          }
          const data = JSON.parse(stdout.substring(jsonStart));
          const responseText = data.response || '';
          if (!responseText) {
            return resolve({ success: false, error: 'Empty response from Gemini CLI' });
          }

          const stats = data.stats?.models?.[model]?.tokens || {};
          console.log('[docs:gemini-cli] Response: ' + Math.round(responseText.length / 1024) + 'KB, input: ' + stats.input + ' output: ' + stats.candidates);
          return resolve({
            success: true,
            text: responseText,
            usage: { input_tokens: stats.input, output_tokens: stats.candidates }
          });
        } catch (parseErr) {
          console.error('[docs:gemini-cli] Parse error:', parseErr.message);
          return resolve({ success: false, error: 'Failed to parse CLI output: ' + parseErr.message });
        }
      });

      // Feed prompt via stdin
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });
  } catch (error) {
    console.error('[docs:gemini-cli] Error:', error);
    return { success: false, error: error.message };
  }
}

/** Read doc prompt from synced settings (file or inline) */
async function readDocPrompt() {
  const { docPrompt } = docsConfig;
  if (docPrompt.useFile && docPrompt.filePath) {
    try {
      if (!fs.existsSync(docPrompt.filePath)) {
        return { success: false, error: 'Prompt file not found: ' + docPrompt.filePath };
      }
      const content = fs.readFileSync(docPrompt.filePath, 'utf-8');
      console.log('[docs:readDocPrompt] Read ' + content.length + ' chars from ' + docPrompt.filePath);
      return { success: true, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  } else if (docPrompt.inlineContent) {
    return { success: true, content: docPrompt.inlineContent };
  }
  return { success: false, error: 'No documentation prompt configured' };
}

/** Read all docs/knowledge/*.md files and return concatenated content */
function readKnowledgeBase(cwd) {
  const knowledgeDir = path.join(cwd, 'docs', 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return { files: 0, content: '' };
  const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort();
  const parts = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
      parts.push('=== ' + file + ' ===\n' + text);
    } catch (_) { /* skip */ }
  }
  const content = parts.join('\n\n');
  console.log('[docs:readKB] ' + parts.length + ' files, ' + Math.round(content.length / 1024) + 'KB from ' + knowledgeDir);
  return { files: parts.length, content };
}

function register() {
  // Read knowledge base (docs/knowledge/*.md) for API handlers
  ipcMain.handle('docs:read-knowledge-base', async (event, { cwd }) => {
    return readKnowledgeBase(cwd);
  });

  // Save combined prompt to /tmp/ for Gemini to read via @filepath
  ipcMain.handle('docs:save-temp', async (event, { content, projectPath }) => {
    try {
      const tmpDir = path.join(projectPath, 'tmp');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const filename = 'noted-docs-' + Date.now() + '.txt';
      const filePath = path.join(tmpDir, filename);
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log('[docs:save-temp] Saved', content.length, 'chars to', filePath);
      return { success: true, filePath };
    } catch (error) {
      console.error('[docs:save-temp] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Read documentation prompt from file
  ipcMain.handle('docs:read-prompt-file', async (event, { filePath }) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt file not found: ' + filePath };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      console.log('[docs:read-prompt] Read prompt file:', filePath, '- Length:', content.length);
      return { success: true, content };
    } catch (error) {
      console.error('[docs:read-prompt] Error reading prompt file:', error);
      return { success: false, error: error.message };
    }
  });

  // Claude API proxy (avoids CORS — renderer can't call api.kiro.cheap directly)
  // Uses synced model from apiSettings if available
  ipcMain.handle('docs:api-request', async (event, { system, prompt, model, thinking }) => {
    const useModel = model || docsConfig.apiSettings.claudeModel || 'claude-opus-4.6';
    const useThinking = thinking || docsConfig.apiSettings.claudeThinking || 'HIGH';
    return callClaudeApi(system, prompt, useModel, useThinking);
  });

  // Gemini CLI headless mode (better quality than raw API — uses CLI system prompt + GEMINI.md)
  ipcMain.handle('docs:gemini-cli-request', async (event, { system, prompt, model, cwd }) => {
    const useModel = model || docsConfig.apiSettings.geminiModel || 'gemini-3-flash-preview';
    return callGeminiCli(system, prompt, useModel, cwd);
  });

  // Sync settings from renderer (apiSettings + docPrompt)
  ipcMain.handle('docs:sync-settings', async (event, config) => {
    if (config.apiSettings) docsConfig.apiSettings = config.apiSettings;
    if (config.docPrompt) docsConfig.docPrompt = config.docPrompt;
    console.log('[docs:sync-settings] Updated: useFile=' + docsConfig.docPrompt.useFile +
      ' claude=' + docsConfig.apiSettings.claudeModel +
      ' gemini=' + docsConfig.apiSettings.geminiModel);
    return { success: true };
  });
}

module.exports = { register, callClaudeApi, callGeminiApi, callGeminiCli, readDocPrompt, getDocsConfig };
