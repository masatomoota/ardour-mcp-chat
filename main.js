'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function writeSettings(data) {
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Anthropic client cache (keyed by apiKey)
// ---------------------------------------------------------------------------

const anthropicClients = new Map();

function getAnthropicClient(apiKey) {
  if (anthropicClients.has(apiKey)) return anthropicClients.get(apiKey);
  // Lazy-import SDK — avoids loading it before app is ready.
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic({ apiKey });
  anthropicClients.set(apiKey, client);
  return client;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('llm-send', async (_event, payload) => {
  const { apiKey, model, max_tokens, system, tools, messages } = payload || {};

  if (!apiKey) {
    return { error: 'API key is not set. Open Settings and enter your Anthropic API key.' };
  }

  try {
    const client = getAnthropicClient(apiKey);

    const params = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 4096,
      messages,
    };
    if (system) params.system = system;
    if (tools && tools.length > 0) params.tools = tools;

    const response = await client.messages.create(params);
    // Return plain object — it is JSON-serializable.
    return response;
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('settings-get', async () => {
  return readSettings();
});

ipcMain.handle('settings-set', async (_event, data) => {
  writeSettings(data);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
