'use strict';

// ============================================================
// Minimal Markdown renderer — no deps, regex-based.
// Supports: headings, bold, italic, inline code, code blocks,
// ordered/unordered lists, links, hard line-breaks.
// Always HTML-escapes first to prevent XSS.
// ============================================================

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Highlight one inline-code span (already escaped).
function spanCode(s) { return `<code class="md-code">${s}</code>`; }

// Run inline transforms on an already-escaped string.
function inlineMarkup(s) {
  // Inline code  `…`
  s = s.replace(/`([^`]+)`/g, (_, c) => spanCode(escHtml(c)));
  // Bold+Italic ***…*** or ___…___
  s = s.replace(/\*\*\*(.+?)\*\*\*|___(.+?)___/g, (_, a, b) =>
    `<strong><em>${a || b}</em></strong>`);
  // Bold **…** or __…__
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) =>
    `<strong>${a || b}</strong>`);
  // Italic *…* or _…_
  s = s.replace(/\*([^*]+)\*|_([^_]+)_/g, (_, a, b) =>
    `<em>${a || b}</em>`);
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, txt, url) => `<a href="${escHtml(url)}" target="_blank" rel="noopener">${txt}</a>`);
  return s;
}

// Render a single paragraph (no block-level elements inside).
function renderParagraph(lines) {
  if (!lines.length) return '';
  return '<p>' + lines.map(l => inlineMarkup(escHtml(l))).join('<br>') + '</p>';
}

// Render one list block [{ordered, items:[string]}]
function renderList(ordered, items) {
  const tag = ordered ? 'ol' : 'ul';
  const inner = items
    .map(item => `<li>${inlineMarkup(escHtml(item))}</li>`)
    .join('');
  return `<${tag}>${inner}</${tag}>`;
}

/**
 * renderMarkdown(text) → HTML string
 */
function renderMarkdown(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- Fenced code block ```
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      const raw = codeLines.join('\n');
      out.push(`<pre class="md-pre"><code class="md-codeblock${lang ? ' lang-' + escHtml(lang) : ''}">${escHtml(raw)}</code></pre>`);
      continue;
    }

    // ---- Heading #…######
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const level = hm[1].length;
      out.push(`<h${level} class="md-h">${inlineMarkup(escHtml(hm[2]))}</h${level}>`);
      i++;
      continue;
    }

    // ---- Horizontal rule ---
    if (/^---+$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    // ---- Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      out.push(renderList(false, items));
      continue;
    }

    // ---- Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''));
        i++;
      }
      out.push(renderList(true, items));
      continue;
    }

    // ---- Blank line: flush nothing (paragraph break handled below)
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ---- Regular paragraph: gather until blank line or block element
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^[-*+]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) out.push(renderParagraph(paraLines));
  }

  return out.join('\n');
}

// Export for renderer.js (IIFE global pattern)
window.renderMarkdown = renderMarkdown;
