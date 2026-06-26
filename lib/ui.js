'use strict';

// ============================================================
// UI helpers — Ardour MCP Companion
// Depends on: window.renderMarkdown (from markdown.js)
// Exports to window.UI
// ============================================================

const UI = (() => {
  // ---- JSON syntax highlighter (~30 lines) ----
  function highlightJson(json) {
    // json is already a plain string (will be HTML-escaped next)
    const esc = json
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return esc.replace(
      /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'jn'; // number
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'jk' : 'js'; // key or string
        } else if (/true|false/.test(match)) {
          cls = 'jb'; // boolean
        } else if (/null/.test(match)) {
          cls = 'jnull';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  // ---- Copy-to-clipboard helper ----
  function makeCopyBtn(getTextFn) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.title = 'Copy to clipboard';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getTextFn());
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      } catch (_) {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }
    });
    return btn;
  }

  // ---- Append animated message row ----
  function appendRow($messages, role, contentEl) {
    const row = document.createElement('div');
    row.className = `msg-row ${role} msg-slide-in`;

    const labelText = { user: 'You', asst: 'Claude', sys: 'System' }[role] || role;
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = labelText;

    row.appendChild(label);
    row.appendChild(contentEl);
    $messages.appendChild(row);
    scrollToBottom($messages);
    return row;
  }

  // ---- Smooth scroll ----
  function scrollToBottom($messages) {
    $messages.scrollTo({ top: $messages.scrollHeight, behavior: 'smooth' });
  }

  // ---- Append bubble (user/sys) ----
  function appendBubble($messages, role, text) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    appendRow($messages, role, bubble);
    return bubble;
  }

  // ---- Append markdown bubble (assistant) ----
  function appendMarkdownBubble($messages, role) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble md-bubble';
    // returns { bubble, setText }
    let accumulated = '';
    function setText(text) {
      accumulated = text;
      bubble.innerHTML = window.renderMarkdown(text);
    }
    appendRow($messages, role, bubble);
    return { bubble, setText };
  }

  // ---- Tool card ----
  function appendToolCard($messages, id, name, input, toolCards) {
    const startTime = Date.now();

    const card = document.createElement('div');
    card.className = 'tool-card msg-slide-in';

    // Header
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const dot = document.createElement('span');
    dot.className = 'tool-status-dot running';

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = name;

    // Args summary in header (truncated to 60 chars)
    const argsSummary = document.createElement('span');
    argsSummary.className = 'tool-args-summary';
    const argsStr = input ? JSON.stringify(input) : '{}';
    argsSummary.textContent = argsStr.length > 60
      ? argsStr.slice(0, 57) + '…'
      : argsStr;

    const statusEl = document.createElement('span');
    statusEl.className = 'tool-status';
    statusEl.textContent = 'running…';

    const chevron = document.createElement('span');
    chevron.className = 'tool-chevron';
    chevron.textContent = '▸';

    header.appendChild(dot);
    header.appendChild(nameEl);
    header.appendChild(argsSummary);
    header.appendChild(statusEl);
    header.appendChild(chevron);

    // Body
    const body = document.createElement('div');
    body.className = 'tool-body';

    // Input section
    const inputSection = document.createElement('div');
    inputSection.className = 'tool-section';
    const inputLabel = document.createElement('div');
    inputLabel.className = 'tool-section-label';
    inputLabel.textContent = 'Input';
    const inputPre = document.createElement('pre');
    inputPre.className = 'tool-json';
    inputPre.innerHTML = highlightJson(JSON.stringify(input || {}, null, 2));
    inputSection.appendChild(inputLabel);
    inputSection.appendChild(inputPre);

    // Output section (placeholder)
    const outputSection = document.createElement('div');
    outputSection.className = 'tool-section';
    const outputLabel = document.createElement('div');
    outputLabel.className = 'tool-section-label';
    outputLabel.textContent = 'Output';
    const outputPre = document.createElement('pre');
    outputPre.className = 'tool-json';
    outputPre.textContent = '…';
    const copyBtn = makeCopyBtn(() => outputPre.textContent);
    const outputHeader = document.createElement('div');
    outputHeader.className = 'tool-section-header';
    outputHeader.appendChild(outputLabel);
    outputHeader.appendChild(copyBtn);
    outputSection.appendChild(outputHeader);
    outputSection.appendChild(outputPre);

    body.appendChild(inputSection);
    body.appendChild(outputSection);

    // Toggle collapse
    let collapsed = true;
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      body.classList.toggle('open', !collapsed);
      chevron.textContent = collapsed ? '▸' : '▾';
    });

    card.appendChild(header);
    card.appendChild(body);

    const row = document.createElement('div');
    row.className = 'tool-card-row';
    row.appendChild(card);
    $messages.appendChild(row);
    scrollToBottom($messages);

    card._dot = dot;
    card._status = statusEl;
    card._outputPre = outputPre;
    card._startTime = startTime;
    card._body = body;
    card._chevron = chevron;
    card._collapsed = () => collapsed;

    toolCards.set(id, card);
    return card;
  }

  function updateToolCard(toolCards, $messages, id, ok, output) {
    const card = toolCards.get(id);
    if (!card) return;

    const elapsed = Date.now() - card._startTime;
    const state = ok ? 'ok' : 'error';
    card._dot.className = `tool-status-dot ${state}`;
    card._status.textContent = `${ok ? 'done' : 'error'} · ${elapsed}ms`;

    // Pretty-print JSON if possible
    let pretty = output || '';
    let displayText = pretty;
    try {
      const parsed = JSON.parse(pretty);
      displayText = JSON.stringify(parsed, null, 2);
    } catch (_) { /* leave as-is */ }

    card._outputPre.innerHTML = highlightJson(displayText);

    scrollToBottom($messages);
  }

  return {
    appendRow,
    scrollToBottom,
    appendBubble,
    appendMarkdownBubble,
    appendToolCard,
    updateToolCard,
    makeCopyBtn,
  };
})();

window.UI = UI;
