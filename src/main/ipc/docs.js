const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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
  ipcMain.handle('docs:api-request', async (event, { system, prompt }) => {
    try {
      console.log('[docs:api-request] Sending', Math.round(prompt.length / 1024) + 'KB to Claude API...');
      const body = {
        model: 'claude-opus-4.6',
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
        console.error('[docs:api-request] API error', response.status, errorText.slice(0, 300));
        return { success: false, error: 'API ' + response.status + ': ' + errorText.slice(0, 200) };
      }

      const data = await response.json();
      const textBlock = data.content?.find(b => b.type === 'text');
      if (!textBlock?.text) {
        return { success: false, error: 'No text block in API response' };
      }

      const usage = data.usage || {};
      console.log('[docs:api-request] Response:', Math.round(textBlock.text.length / 1024) + 'KB, input:', usage.input_tokens, 'output:', usage.output_tokens);
      return { success: true, text: textBlock.text, usage };
    } catch (error) {
      console.error('[docs:api-request] Error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register };
