'use strict';

// ============================================================
// Renderer — Ardour MCP Companion
// Vanilla DOM, no framework. Uses:
//   window.api        from preload.js
//   window.renderMarkdown  from lib/markdown.js
//   window.UI         from lib/ui.js
// ============================================================

// ---------------------------------------------------------------------------
// McpClient (browser-side — uses window.fetch)
// ---------------------------------------------------------------------------
class McpClient {
  constructor(url) {
    this.url = url;
    this._id = 0;
    this.serverInfo = null;
  }

  async request(method, params) {
    this._id += 1;
    const body = { jsonrpc: '2.0', id: this._id, method };
    if (params !== undefined) body.params = params;
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`MCP network error: ${err.message}`);
    }
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
    if (json.error) {
      const code = json.error.code;
      const msg  = json.error.message || JSON.stringify(json.error);
      const err  = new Error(msg);
      err.code   = code;
      throw err;
    }
    return json.result;
  }

  async notify(method, params) {
    const body = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) { /* fire-and-forget */ }
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ardour-mcp-companion', version: '0.1.0' },
    });
    this.serverInfo = result.serverInfo || null;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args || {} });
  }
}

// ---------------------------------------------------------------------------
// AgentLoop (browser-side)
// ---------------------------------------------------------------------------
const MAX_ITER = 20;

class AgentLoop {
  constructor({ llmClient, mcpClient, model, systemPrompt, onEvent, enabledNamespaces }) {
    this.llmClient        = llmClient;
    this.mcpClient        = mcpClient;
    this.model            = model || 'claude-sonnet-4-6';
    this.systemPrompt     = systemPrompt || '';
    this.onEvent          = onEvent || (() => {});
    this.enabledNamespaces = enabledNamespaces || null; // null = pass all
    this.messages         = [];
    this._tools           = null;
  }

  mapMcpToolToAnthropic(t) {
    return {
      name:         t.name,
      description:  t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    };
  }

  async _getTools() {
    if (this._tools) return this._tools;
    try {
      const raw = await this.mcpClient.listTools();
      const all = raw.map((t) => this.mapMcpToolToAnthropic(t));
      this._tools = filterToolsByNamespaces(all, this.enabledNamespaces);
    } catch (_) { this._tools = []; }
    return this._tools;
  }

  async sendUser(text) {
    this.messages.push({ role: 'user', content: text });
    await this.runLoop();
  }

  async runLoop() {
    const tools = await this._getTools();

    for (let iter = 0; iter < MAX_ITER; iter++) {
      let response;
      try {
        response = await this.llmClient.createMessage({
          model:      this.model,
          max_tokens: 4096,
          system:     this.systemPrompt,
          tools:      tools.length > 0 ? tools : undefined,
          messages:   this.messages,
        });
      } catch (err) {
        this.onEvent({ type: 'error', message: err.message || String(err) });
        return;
      }

      if (response.error) {
        this.onEvent({ type: 'error', message: response.error, raw: response });
        return;
      }

      const assistantContent = response.content || [];

      for (const block of assistantContent) {
        if (block.type === 'text') {
          this.onEvent({ type: 'assistant-text', text: block.text });
        } else if (block.type === 'tool_use') {
          this.onEvent({ type: 'tool-use', id: block.id, name: block.name, input: block.input });
        }
      }

      if (response.stop_reason !== 'tool_use') {
        this.messages.push({ role: 'assistant', content: assistantContent });
        return;
      }

      this.messages.push({ role: 'assistant', content: assistantContent });

      const toolResultBlocks = [];
      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;
        let resultContent;
        let ok = true;
        try {
          const mcpResult = await this.mcpClient.callTool(block.name, block.input);
          if (mcpResult && Array.isArray(mcpResult.content)) {
            resultContent = mcpResult.content
              .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
              .join('\n') || JSON.stringify(mcpResult);
          } else {
            resultContent = JSON.stringify(mcpResult);
          }
        } catch (err) {
          ok = false;
          resultContent = `Error: ${err.message}`;
          // MCP -32602 = invalid params / not found
          if (err.code === -32602) {
            this.onEvent({
              type: 'hint',
              message: `Tool "${block.name}" not found (-32602). Try reconnecting to Ardour.`,
            });
          }
        }
        this.onEvent({ type: 'tool-result', id: block.id, ok, output: resultContent });
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent });
      }

      this.messages.push({ role: 'user', content: toolResultBlocks });
    }

    this.onEvent({ type: 'error', message: `Agent loop exceeded ${MAX_ITER} iterations.` });
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const DEFAULT_SYSTEM =
  "You are an Ardour DAW assistant. Use the provided tools to inspect and edit the " +
  "user's session. Confirm before destructive operations. Be concise.";

let settings = {
  apiKey:       '',
  model:        'claude-sonnet-4-6',
  mcpUrl:       'http://127.0.0.1:4820/mcp',
  systemPrompt: DEFAULT_SYSTEM,
};

let mcpClient        = null;
let toolCount        = 0;
let mcpServerInfo    = null;
let inFlight         = false;
let lastKnownRawTools = []; // populated after successful connectMcp(); used by T11 UI

// Map tool_use id -> DOM card element
const toolCards = new Map();

// Conversation history for persistence (lightweight: just for display reload)
// Format: [{role, text, type}]
const CONV_KEY = 'ardour-mcp-conversation';

// ---------------------------------------------------------------------------
// DOM refs (resolved after DOMContentLoaded)
// ---------------------------------------------------------------------------
let $messages, $input, $composer, $connectBtn, $reconnectBtn, $clearBtn;
let $statusDot, $statusLabel, $statusTooltip;
let $settingsDialog, $settingsBtn, $settingsClose, $settingsCancel, $settingsSave;
let $cfgApiKey, $cfgModel, $cfgMcpUrl, $cfgSystem;
let $apiKeyHint, $mcpUrlHint;
let $testApiBtn, $testMcpBtn;
let $sendBtn, $sendLabel, $sendSpinner;
let $systemPromptPeek, $systemPromptText;

// ---------------------------------------------------------------------------
// LLM client wrapper
// ---------------------------------------------------------------------------
const llmClient = {
  async createMessage(params) {
    if (!settings.apiKey) {
      return { error: 'Set API key in Settings before sending messages.' };
    }
    const payload = { apiKey: settings.apiKey, ...params };
    return window.api.llmSend(payload);
  },
};

// ---------------------------------------------------------------------------
// T11 — Tool namespace filter
// ---------------------------------------------------------------------------
const NAMESPACE_MAP = [
  { key: 'transport',   label: 'Transport',   match: t => t.name.startsWith('transport_') },
  { key: 'track',       label: 'Track',        match: t => t.name.startsWith('track_') || t.name.startsWith('tracks_') },
  { key: 'region',      label: 'Regions',      match: t => t.name.startsWith('region_') },
  { key: 'markers',     label: 'Markers',      match: t => t.name.startsWith('markers_') },
  { key: 'session',     label: 'Session',      match: t => t.name.startsWith('session_') },
  { key: 'plugin',      label: 'Plugins',      match: t => t.name.startsWith('plugin_') },
  { key: 'automation',  label: 'Automation',   match: t => t.name.startsWith('automation_') },
  { key: 'midi',        label: 'MIDI',         match: t => t.name.startsWith('midi_') },
  { key: 'buses',       label: 'Buses',        match: t => t.name.startsWith('buses_') },
  { key: 'diagnostics', label: 'Diagnostics',  match: t => t.name === 'hello_world' },
];

/**
 * Returns tools filtered to enabled namespaces.
 * When enabledKeys is null/empty the full list is returned (safe fallback).
 * Tools whose name does not match any namespace are always passed through.
 */
function filterToolsByNamespaces(tools, enabledKeys) {
  if (!enabledKeys || enabledKeys.length === 0) return tools;
  const enabled = new Set(enabledKeys);
  return tools.filter(t => {
    for (const ns of NAMESPACE_MAP) {
      if (ns.match(t)) return enabled.has(ns.key);
    }
    return true; // unknown prefix — always pass through
  });
}

function renderToolsSection() {
  const grid = document.getElementById('cfg-tools-grid');
  if (!grid) return;
  const allKeys = NAMESPACE_MAP.map(n => n.key);
  const enabled = new Set(settings.enabledNamespaces && settings.enabledNamespaces.length > 0
    ? settings.enabledNamespaces
    : allKeys);
  grid.innerHTML = '';
  for (const ns of NAMESPACE_MAP) {
    const count = lastKnownRawTools.filter(t => ns.match(t)).length;
    const label = document.createElement('label');
    label.className = 'tool-ns-checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.ns = ns.key;
    cb.checked = enabled.has(ns.key);
    cb.addEventListener('change', updateToolsCount);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${ns.label} `));
    const countSpan = document.createElement('span');
    countSpan.className = 'ns-count';
    countSpan.textContent = `(${count})`;
    label.appendChild(countSpan);
    grid.appendChild(label);
  }
  updateToolsCount();
  const allBtn  = document.getElementById('tools-all-btn');
  const noneBtn = document.getElementById('tools-none-btn');
  if (allBtn)  allBtn.onclick  = () => { grid.querySelectorAll('input').forEach(cb => { cb.checked = true;  }); updateToolsCount(); };
  if (noneBtn) noneBtn.onclick = () => { grid.querySelectorAll('input').forEach(cb => { cb.checked = false; }); updateToolsCount(); };
}

function updateToolsCount() {
  const countEl = document.getElementById('cfg-tools-count');
  if (!countEl) return;
  const checked = [...document.querySelectorAll('#cfg-tools-grid input[type="checkbox"]:checked')].map(cb => cb.dataset.ns);
  const enabledCount = filterToolsByNamespaces(lastKnownRawTools, checked).length;
  const total = lastKnownRawTools.length;
  countEl.textContent = total > 0
    ? `${enabledCount} / ${total} tools enabled`
    : '(connect first)';
  if (checked.length === 0 && total > 0) {
    countEl.textContent += ' — warning: all tools will be sent (disable-all fallback)';
  }
}

// ---------------------------------------------------------------------------
// Status / tooltip
// ---------------------------------------------------------------------------
function setStatus(state, label) {
  $statusDot.className = `status-dot ${state}`;
  $statusDot.dataset.state = state;
  $statusLabel.textContent = label;

  // Show/hide reconnect button
  const needReconnect = (state === 'disconnected' || state === 'error');
  $reconnectBtn.style.display = needReconnect ? '' : 'none';
  $connectBtn.style.display   = needReconnect ? 'none' : '';

  updateTooltip();
}

function updateTooltip() {
  const lines = [
    `URL: ${settings.mcpUrl || '(not set)'}`,
  ];
  if (mcpServerInfo) {
    lines.push(`Server: ${mcpServerInfo.name || '?'} v${mcpServerInfo.version || '?'}`);
  }
  if (toolCount > 0) lines.push(`Tools loaded: ${toolCount}`);
  $statusTooltip.textContent = lines.join('\n');
}

// Wire tooltip hover on status area
function wireTooltip() {
  const anchor = document.querySelector('.header-left');
  anchor.addEventListener('mouseenter', () => {
    $statusTooltip.hidden = false;
  });
  anchor.addEventListener('mouseleave', () => {
    $statusTooltip.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Conversation persistence (localStorage)
// ---------------------------------------------------------------------------
// We store a simplified log: [{role, content, kind}]
// role: 'user'|'asst'|'sys'|'tool'
// kind: 'text'|'tool-use'|'tool-result'|'hint'
let convLog = [];

function persistConv() {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(convLog)); } catch (_) {}
}

function loadConvLog() {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [];
}

function replayConvLog(log) {
  for (const entry of log) {
    if (entry.role === 'user') {
      appendBubble('user', entry.content);
    } else if (entry.role === 'asst') {
      appendAsstText(entry.content);
    } else if (entry.role === 'sys' || entry.role === 'hint') {
      appendSystemMsg(entry.content);
    }
    // tool cards are not replayed (complex state); just skip
  }
}

// ---------------------------------------------------------------------------
// UI: append helpers (thin wrappers over window.UI)
// ---------------------------------------------------------------------------
function scrollToBottom() {
  window.UI.scrollToBottom($messages);
}

let currentAsstBubble = null;   // {bubble, setText} from UI.appendMarkdownBubble
let currentAsstText   = '';

function appendAsstText(fullText) {
  const h = window.UI.appendMarkdownBubble($messages, 'asst');
  h.setText(fullText);
  return h;
}

function appendBubble(role, text) {
  return window.UI.appendBubble($messages, role, text);
}

function appendSystemMsg(text) {
  return window.UI.appendBubble($messages, 'sys', text);
}

// ---------------------------------------------------------------------------
// onEvent handler (called by AgentLoop)
// ---------------------------------------------------------------------------
function onEvent(event) {
  switch (event.type) {
    case 'assistant-text': {
      if (!currentAsstBubble) {
        currentAsstText   = '';
        currentAsstBubble = window.UI.appendMarkdownBubble($messages, 'asst');
      }
      currentAsstText += event.text;
      currentAsstBubble.setText(currentAsstText);
      scrollToBottom();
      break;
    }

    case 'tool-use': {
      // Commit current assistant text to log before tool card
      if (currentAsstText) {
        convLog.push({ role: 'asst', content: currentAsstText });
        persistConv();
      }
      currentAsstBubble = null;
      currentAsstText   = '';
      window.UI.appendToolCard($messages, event.id, event.name, event.input, toolCards);
      break;
    }

    case 'tool-result': {
      window.UI.updateToolCard(toolCards, $messages, event.id, event.ok, event.output);
      break;
    }

    case 'hint': {
      appendSystemMsg('Hint: ' + event.message);
      convLog.push({ role: 'hint', content: event.message });
      persistConv();
      break;
    }

    case 'error': {
      currentAsstBubble = null;
      currentAsstText   = '';

      let msg = event.message || 'Unknown error';
      // Rate-limit / overload suggestions
      if (/rate.?limit/i.test(msg)) {
        msg += '\n\nSuggestion: Wait a moment then retry. Consider switching to a faster model in Settings.';
      } else if (/overloaded/i.test(msg)) {
        msg += '\n\nSuggestion: Anthropic API is overloaded — please try again in a few seconds.';
      }
      appendSystemMsg(msg);
      convLog.push({ role: 'sys', content: msg });
      persistConv();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Connect to MCP
// ---------------------------------------------------------------------------
async function connectMcp() {
  const url = settings.mcpUrl || 'http://127.0.0.1:4820/mcp';
  setStatus('connecting', 'Connecting…');
  $connectBtn.disabled    = true;
  $reconnectBtn.disabled  = true;

  try {
    const client = new McpClient(url);
    const initResult = await client.initialize();
    const tools = await client.listTools();
    mcpClient        = client;
    toolCount        = tools.length;
    mcpServerInfo    = initResult.serverInfo || null;
    lastKnownRawTools = tools;
    setStatus('connected', `Connected — ${toolCount} tools`);
    $connectBtn.textContent = 'Reconnect';
    updateTooltip();
  } catch (err) {
    mcpClient     = null;
    mcpServerInfo = null;
    toolCount     = 0;
    setStatus('error', 'Connection failed');
    appendSystemMsg(
      `Cannot reach ${url}. Is Ardour running with the MCP HTTP surface enabled?\n\n${err.message}`
    );
    updateTooltip();
  } finally {
    $connectBtn.disabled   = false;
    $reconnectBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------
async function sendMessage() {
  const text = $input.value.trim();
  if (!text || inFlight) return;

  if (!settings.apiKey) {
    appendSystemMsg('Set API key in Settings before sending messages.');
    $input.focus();
    return;
  }

  if (!mcpClient) {
    appendSystemMsg('Not connected to Ardour. Click Connect first.');
    $input.focus();
    return;
  }

  $input.value = '';  // clear content first so scrollHeight is 0
  $input.dispatchEvent(new Event('input')); // reset height via auto-grow handler

  appendBubble('user', text);
  convLog.push({ role: 'user', content: text });
  persistConv();

  currentAsstBubble = null;
  currentAsstText   = '';

  setInFlight(true);

  const loop = new AgentLoop({
    llmClient,
    mcpClient,
    model:             settings.model,
    systemPrompt:      settings.systemPrompt,
    enabledNamespaces: settings.enabledNamespaces || null,
    onEvent,
  });

  try {
    await loop.sendUser(text);
    // Commit final assistant text to log
    if (currentAsstText) {
      convLog.push({ role: 'asst', content: currentAsstText });
      persistConv();
    }
  } finally {
    currentAsstBubble = null;
    currentAsstText   = '';
    setInFlight(false);
    $input.focus();
  }
}

function setInFlight(v) {
  inFlight = v;
  $sendBtn.disabled   = v;
  $input.disabled     = v;
  $sendLabel.hidden   = v;
  $sendSpinner.hidden = !v;
}

// ---------------------------------------------------------------------------
// Clear conversation
// ---------------------------------------------------------------------------
function clearConversation() {
  if (!confirm('Clear conversation history?')) return;
  convLog = [];
  persistConv();
  while ($messages.firstChild) $messages.removeChild($messages.firstChild);
  toolCards.clear();
  currentAsstBubble = null;
  currentAsstText   = '';
  appendSystemMsg('Conversation cleared.');
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
function openSettings() {
  $cfgApiKey.value  = settings.apiKey || '';
  $cfgModel.value   = settings.model  || 'claude-sonnet-4-6';
  $cfgMcpUrl.value  = settings.mcpUrl || 'http://127.0.0.1:4820/mcp';
  $cfgSystem.value  = settings.systemPrompt || '';
  $apiKeyHint.textContent = '';
  $mcpUrlHint.textContent = '';
  renderToolsSection();
  $settingsDialog.showModal();
  $cfgApiKey.focus();
}

function closeSettings() {
  $settingsDialog.close();
  $input.focus();
}

function validateSettings() {
  let ok = true;
  const key = $cfgApiKey.value.trim();
  const url = $cfgMcpUrl.value.trim();

  if (!key) {
    $apiKeyHint.textContent = 'API key is required.';
    $apiKeyHint.className = 'field-hint error';
    ok = false;
  } else if (!key.startsWith('sk-ant-')) {
    $apiKeyHint.textContent = 'Key should start with "sk-ant-".';
    $apiKeyHint.className = 'field-hint warn';
  } else {
    $apiKeyHint.textContent = '';
  }

  if (!url) {
    $mcpUrlHint.textContent = 'MCP endpoint URL is required.';
    $mcpUrlHint.className = 'field-hint error';
    ok = false;
  } else {
    try {
      new URL(url);
      $mcpUrlHint.textContent = '';
    } catch (_) {
      $mcpUrlHint.textContent = 'Malformed URL.';
      $mcpUrlHint.className = 'field-hint error';
      ok = false;
    }
  }
  return ok;
}

async function saveSettings() {
  if (!validateSettings()) return;

  settings.apiKey       = $cfgApiKey.value.trim();
  settings.model        = $cfgModel.value;
  settings.mcpUrl       = $cfgMcpUrl.value.trim() || 'http://127.0.0.1:4820/mcp';
  settings.systemPrompt = $cfgSystem.value || DEFAULT_SYSTEM;

  // T11: persist enabled tool namespaces
  const checkedBoxes = document.querySelectorAll('#cfg-tools-grid input[type="checkbox"]:checked');
  if (checkedBoxes.length > 0) {
    settings.enabledNamespaces = [...checkedBoxes].map(cb => cb.dataset.ns);
  }
  // If grid does not exist yet (no tools connected) leave enabledNamespaces untouched.

  await window.api.settingsSet(settings);
  updateSystemPromptPeek();
  closeSettings();
}

// ---- Test API key ----
async function testApiKey() {
  const key = $cfgApiKey.value.trim();
  if (!key) { $apiKeyHint.textContent = 'Enter a key first.'; $apiKeyHint.className = 'field-hint error'; return; }

  $testApiBtn.disabled = true;
  $testApiBtn.textContent = 'Testing…';
  $apiKeyHint.textContent = '';

  try {
    const result = await window.api.llmSend({
      apiKey: key,
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    if (result && result.error) {
      $apiKeyHint.textContent = 'Error: ' + result.error;
      $apiKeyHint.className = 'field-hint error';
    } else {
      $apiKeyHint.textContent = 'API key OK.';
      $apiKeyHint.className = 'field-hint ok';
    }
  } catch (err) {
    $apiKeyHint.textContent = 'Error: ' + err.message;
    $apiKeyHint.className = 'field-hint error';
  } finally {
    $testApiBtn.disabled = false;
    $testApiBtn.textContent = 'Test';
  }
}

// ---- Test MCP URL ----
async function testMcpUrl() {
  const url = $cfgMcpUrl.value.trim();
  if (!url) { $mcpUrlHint.textContent = 'Enter a URL first.'; $mcpUrlHint.className = 'field-hint error'; return; }

  try { new URL(url); } catch (_) {
    $mcpUrlHint.textContent = 'Malformed URL.';
    $mcpUrlHint.className = 'field-hint error';
    return;
  }

  $testMcpBtn.disabled = true;
  $testMcpBtn.textContent = 'Testing…';
  $mcpUrlHint.textContent = '';

  try {
    const tmp = new McpClient(url);
    const result = await tmp.initialize();
    const tools  = await tmp.listTools();
    const info   = result.serverInfo || {};
    $mcpUrlHint.textContent =
      `OK — ${info.name || 'server'} v${info.version || '?'}, ${tools.length} tools`;
    $mcpUrlHint.className = 'field-hint ok';
  } catch (err) {
    $mcpUrlHint.textContent = 'Error: ' + err.message;
    $mcpUrlHint.className = 'field-hint error';
  } finally {
    $testMcpBtn.disabled = false;
    $testMcpBtn.textContent = 'Test';
  }
}

// ---------------------------------------------------------------------------
// System prompt peek
// ---------------------------------------------------------------------------
function updateSystemPromptPeek() {
  $systemPromptText.textContent = settings.systemPrompt || DEFAULT_SYSTEM;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
function wireKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Suppress all global shortcuts while the settings modal is open so that
    // Cmd+Enter, Cmd+K, and Cmd+, do not fire through the modal backdrop.
    if ($settingsDialog.open) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // Cmd/Ctrl+, → Settings
    if (e.key === ',') {
      e.preventDefault();
      openSettings();
      return;
    }
    // Cmd/Ctrl+K → Clear
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      clearConversation();
      return;
    }
    // Cmd/Ctrl+Enter → Send
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  // Resolve DOM refs
  $messages          = document.getElementById('messages');
  $input             = document.getElementById('input');
  $composer          = document.getElementById('composer');
  $connectBtn        = document.getElementById('connect-btn');
  $reconnectBtn      = document.getElementById('reconnect-btn');
  $clearBtn          = document.getElementById('clear-btn');
  $statusDot         = document.getElementById('status-dot');
  $statusLabel       = document.getElementById('status-label');
  $statusTooltip     = document.getElementById('status-tooltip');
  $settingsDialog    = document.getElementById('settings-dialog');
  $settingsBtn       = document.getElementById('settings-btn');
  $settingsClose     = document.getElementById('settings-close');
  $settingsCancel    = document.getElementById('settings-cancel');
  $settingsSave      = document.getElementById('settings-save');
  $cfgApiKey         = document.getElementById('cfg-api-key');
  $cfgModel          = document.getElementById('cfg-model');
  $cfgMcpUrl         = document.getElementById('cfg-mcp-url');
  $cfgSystem         = document.getElementById('cfg-system');
  $apiKeyHint        = document.getElementById('api-key-hint');
  $mcpUrlHint        = document.getElementById('mcp-url-hint');
  $testApiBtn        = document.getElementById('test-api-btn');
  $testMcpBtn        = document.getElementById('test-mcp-btn');
  $sendBtn           = document.getElementById('send-btn');
  $sendLabel         = document.getElementById('send-label');
  $sendSpinner       = document.getElementById('send-spinner');
  $systemPromptPeek  = document.getElementById('system-prompt-peek');
  $systemPromptText  = document.getElementById('system-prompt-text');

  // Load persisted settings
  const saved = await window.api.settingsGet();
  if (saved && typeof saved === 'object') {
    Object.assign(settings, saved);
  }
  updateSystemPromptPeek();

  // Reload conversation from localStorage
  convLog = loadConvLog();
  if (convLog.length > 0) {
    replayConvLog(convLog);
  }

  // Wire events
  $connectBtn.addEventListener('click', connectMcp);
  $reconnectBtn.addEventListener('click', connectMcp);
  $clearBtn.addEventListener('click', clearConversation);
  $settingsBtn.addEventListener('click', openSettings);
  $settingsClose.addEventListener('click', closeSettings);
  $settingsCancel.addEventListener('click', closeSettings);
  $settingsSave.addEventListener('click', saveSettings);
  $testApiBtn.addEventListener('click', testApiKey);
  $testMcpBtn.addEventListener('click', testMcpUrl);

  $composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

  // Enter = send; Shift+Enter = newline; Cmd/Ctrl+Enter handled by global shortcut
  $input.addEventListener('keydown', (e) => {
    // Guard: do NOT send while an IME composition is in progress.
    // e.isComposing is false once the IME has committed the text,
    // so the *second* Enter (the one that actually submits) goes through.
    // e.keyCode === 229 is a belt-and-suspenders guard for older WebKit
    // builds that do not set isComposing reliably on the closing Enter.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey
        && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-grow textarea (max 8 lines ≈ 8 * 21px = 168px)
  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    const capped = $input.scrollHeight > 168;
    $input.style.height = Math.min($input.scrollHeight, 168) + 'px';
    // Only show scroll when capped — avoids phantom scrollbar at short content.
    $input.style.overflowY = capped ? 'auto' : 'hidden';
  });

  wireTooltip();
  wireKeyboardShortcuts();

  // Greeting (only if no history was replayed)
  if (convLog.length === 0) {
    appendSystemMsg('Welcome! Connect to Ardour, then chat to control your session.');
  }
}

document.addEventListener('DOMContentLoaded', init);
