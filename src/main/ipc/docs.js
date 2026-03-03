const { ipcMain } = require('electron');
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
    geminiModel: 'gemini-3-flash-preview',
    geminiThinking: 'HIGH'
  }
};

function getDocsConfig() {
  return docsConfig;
}

// ── Reusable API call functions (used by IPC handlers AND MCP HTTP endpoint) ──

async function callClaudeApi(system, prompt, model = 'claude-opus-4.6') {
  try {
    console.log('[docs:claude-api] Sending ' + Math.round(prompt.length / 1024) + 'KB to Claude API, model=' + model);
    const body = {
      model,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (system) body.system = system;

    const response = await fetch('https://api.kiro.cheap/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-aw-57742ca44f8b04d8fdd587f8289c7fb1',
        'anthropic-version': '2023-06-01',
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

function register() {
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
  ipcMain.handle('docs:api-request', async (event, { system, prompt, model }) => {
    const useModel = model || docsConfig.apiSettings.claudeModel || 'claude-opus-4.6';
    return callClaudeApi(system, prompt, useModel);
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

module.exports = { register, callClaudeApi, callGeminiApi, readDocPrompt, getDocsConfig };
