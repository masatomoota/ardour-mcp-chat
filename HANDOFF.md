# Ardour MCP Companion — 実装ハンドオフ

> **ABSTRACT (English, for any LLM picking this up cold):** This document is a complete, self-contained handoff for continuing work on the **Ardour MCP Companion** — a dedicated Electron desktop chat app that drives Ardour by natural language via the MCP HTTP control surface running at `http://127.0.0.1:4820/mcp`. The app is the **client side** of the companion architecture; the **server side** lives at [masatomoota/ardour, branch `feature/mcp-fresh-macos`](https://github.com/masatomoota/ardour/tree/feature/mcp-fresh-macos). The two are deliberately **separate processes** so this client carries an MIT license (no GPL inheritance from Ardour). Repo state at handoff: 1 clean initial commit, 14 tracked files / ~2{,}770 LOC, statically verified, MCP client unit-tested, Electron launch sanity-passed. You do **not** need the originating chat. Prose is Japanese; code, paths, identifiers are English; every claim carries a `file:line` or commit citation. Start at §0, then §3 (quick start) or §6 (roadmap).

> **See also:** project-wide master handoff at https://github.com/masatomoota/llm-daw-handoff (chronological narrative, decision tree, prioritized roadmap to 100%, auto-start protocol).

---

## 0. このドキュメントの使い方・前提

- **目的**：別の LLM / エンジニアが**ゼロ知識から実装を継続**するための、ハンドオフ。
- **対象**：本リポ（`ardour-mcp-chat`）。対の Ardour 側は別リポ（masatomoota/ardour 上の `feature/mcp-fresh-macos`）に独立。両者は HTTP/JSON-RPC 越しに疎結合。
- **検証マシン**：macOS Apple Silicon（arm64）/ Node.js 22 / Electron 42 / Homebrew 6.x（macOSベースの想定だが Electron なので Linux/Windows でも理屈上動く）。
- **重要な前提知識**：本アプリは「Anthropic Claude API」を呼んでツール使用ループを回し、ツール実行は「Ardour MCP HTTP サーバ」へ JSON-RPC で送る。両エンドポイントの仕様は §2 で網羅。

---

## 1. アーキテクチャ（10秒で理解）

```
+----------------------+   IPC (contextIsolation)   +----------------------+
| Renderer (chat UI)   | <------------------------> | Main (Node, secrets) |
|  index.html          |                            |  main.js             |
|  renderer.js (751)   |   window.api.llmSend ----> |  @anthropic-ai/sdk   |
|  lib/ui.js (239)     |                            |  settings.json store |
|  lib/markdown.js     |                            +----------+-----------+
|  lib/mcp-client.js   |                                       |
|  lib/agent-loop.js   |                                       v
+----------+-----------+                            api.anthropic.com
           |
           | fetch (HTTP)
           v
http://127.0.0.1:4820/mcp   (Ardour MCP HTTP surface — same project, server side)
```

- **Main プロセス** (`main.js`)：APIキー秘匿、設定ファイル I/O、Anthropic SDK 呼び出し（クロスオリジン回避＋鍵が renderer に出ない）。
- **Renderer プロセス** (`renderer.js` + `lib/*`)：UI／会話状態／MCP 呼び出し（MCP には秘密が要らないので renderer から直接 fetch して低レイテンシ）。
- **エージェントループ** (`lib/agent-loop.js`)：`user → Claude(+tools) → tool_use → MCP tools/call → tool_result → Claude → ... → end_turn`、最大20反復。

---

## 2. プロトコル仕様（Wave 2 でライブ検証済み）

### 2.1 Ardour MCP HTTP サーバ
- **エンドポイント**: `POST http://127.0.0.1:4820/mcp`、`Content-Type: application/json`
- **JSON-RPC 2.0**、`protocolVersion = "2025-03-26"`、96 tools
- **Host ヘッダ検証あり**：loopback（`127.0.0.1` / `localhost` / `::1`）以外は **HTTP 403**。Host 欠落は許可（local CLI 互換）
- **ループバック bind 固定**：`_info.iface = "127.0.0.1"`（Ardour 側 Phase 0 ハードニング済み）

シーケンス：
```
1. POST {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ardour-mcp-companion","version":"0.1.0"}}}
   <- {"result":{"protocolVersion":"...","capabilities":{...},"serverInfo":{"name":"ardour-mcp-http","version":"0.1.0"}}}

2. POST {"jsonrpc":"2.0","method":"notifications/initialized"}   (no id, no response)

3. POST {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
   <- {"result":{"tools":[{"name":"...","title":"...","description":"...","inputSchema":{...},"outputSchema":{...}?}, ...]}}

4. POST {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}
   <- {"result":{"content":[{"type":"text","text":"..."}], "structuredContent":{...}?}}
   または {"error":{"code":-32602,"message":"..."}}
```

### 2.2 Anthropic Messages API（ツール使用ループ）
```js
const Anthropic = require('@anthropic-ai/sdk').default
const client = new Anthropic({ apiKey })
const resp = await client.messages.create({
  model: 'claude-sonnet-4-6',  // or claude-opus-4-8 / claude-haiku-4-5-20251001
  max_tokens: 4096,
  system: '<system prompt>',
  tools: mcpTools.map(t => ({
    name: t.name,                       // e.g. "track_get_meter"
    description: t.description,
    input_schema: t.inputSchema         // JSON Schema, snake_case key per Anthropic
  })),
  messages: [...]
})
// resp.content[] = mix of {type:'text', text} and {type:'tool_use', id, name, input}
// resp.stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
// while 'tool_use': dispatch each via MCP, return as user message:
//   { role:'user', content:[{type:'tool_result', tool_use_id:id, content:'<string>'}] }
```

### 2.3 注意点
- **MCP ツール名にスラッシュが入る**（`track/get_meter` 等）。Anthropic API は `name` に `[a-zA-Z0-9_-]+` のみ許容する場合があるので、**snake_case alias を使う**（既存サーバが `canonical_tool_name()` で `track_get_meter` も `track/get_meter` 両方受理）。本クライアントは `inputSchema.name` をそのまま渡しているが、サーバ側で正規化されるため動作する。万一 Anthropic 側でリジェクトされたら、`/` を `_` に置換する変換層を `lib/agent-loop.js:mapMcpToolToAnthropic` に入れる。
- **`tool_result.content` は文字列**（Anthropic SDK の制約）。MCP の構造化結果（`structuredContent`）を**JSON.stringify** してから渡す。
- **ループ最大 20 反復**（`lib/agent-loop.js`）。暴走防止。実用上は 3〜10 で end_turn する想定。

---

## 3. クイックスタート（30秒）

```bash
git clone https://github.com/masatomoota/ardour-mcp-chat.git
cd ardour-mcp-chat
npm install                 # @anthropic-ai/sdk + Electron 42
npm start                   # opens the desktop window
```

初回起動時の手順：
1. **Settings**（歯車）を開く
2. **Anthropic API Key** を入力（main プロセスのみで保持、UI からは見えない `settings.json`）
3. **Model** を選択（default: `claude-sonnet-4-6`）
4. **MCP endpoint URL**: default `http://127.0.0.1:4820/mcp`
5. **Connect** をクリック（緑のドットになれば 96 tools 取得済み）
6. チャット欄に「現在のセッションの状態を教えて」と入力 → Send

Ardour 側は別途起動が必要（masatomoota/ardour の `feature/mcp-fresh-macos` ブランチ、`MCP_LLM_CONTROL_HANDOFF.md` §3 参照）。

---

## 4. ファイル構成（実体）

| ファイル | LOC | 役割 |
|---|---:|---|
| `package.json` | — | name=ardour-mcp-companion, license=MIT, main=main.js, deps={@anthropic-ai/sdk:^0.32.0, electron:^42.0.0} |
| `main.js` | 108 | Electron main: BrowserWindow 1200x800, IPC `llm-send`/`settings-{get,set}`, settings JSON at `app.getPath('userData')/settings.json` |
| `preload.js` | 9 | contextBridge: `window.api = { llmSend, settingsGet, settingsSet }` |
| `index.html` | 93 | DOM shell: header(status dot+settings)、`#messages`、`#composer`、`<dialog id=settings>` |
| `styles.css` | 518 | Dark theme、message bubbles、collapsible tool cards、status dot、smooth scroll |
| `renderer.js` | 751 | チャットUX一切（init, agent loop driver, message rendering, settings dialog, shortcut, persistence） |
| `lib/mcp-client.js` | 103 | `McpClient` class: `initialize()`, `listTools()`, `callTool(name, args)`, internal `request()`、純 fetch、第三者依存ゼロ |
| `lib/agent-loop.js` | 157 | `AgentLoop` class: 会話履歴、`sendUser()` → tool_use ループ、`onEvent` イベント駆動、最大20反復 |
| `lib/ui.js` | 239 | DOM ヘルパ（message bubble factory, tool card factory, syntax-highlight JSON, copy-to-clipboard）|
| `lib/markdown.js` | 147 | regex ベースの最小 Markdown レンダラ（**bold**, *italic*, `code`, code block, links, lists、XSS-safe escape 先行）|
| `LICENSE` | — | MIT (Copyright 2026 Ardour MCP Companion contributors) |
| `README.md` | — | ユーザ向けクイックスタート |
| `.gitignore` | — | node_modules, settings.json, **.env** など |

総 2{,}774 LOC（package-lock.json 等含む）。

---

## 5. 主要設計判断（後続が踏襲すべきもの）

1. **MIT license**：Electron アプリは Ardour と**別プロセス・別バイナリ**で HTTP 越しに通信するため、GPLv2-or-later の派生関係に該当しない。クローズドソース派生も理論上可能。逆に MIT なので商用利用や統合も自由。詳細は親プロジェクトの `license_report.pdf` 参照。
2. **依存最小**：プロダクション依存は **Anthropic SDK 1 個のみ**。Markdown レンダラ・JSON ハイライト・UI フレームワークはすべて自前（vanilla JS）。これは「次の LLM が読める / 改造できる」ことを優先した判断。
3. **API キーは main プロセスにのみ保持**：renderer は `window.api.llmSend({apiKey, ...})` で渡すが、設定からの読み出しは main 側のみ。Anthropic 呼び出しも main 側で実施し、レスポンス JSON のみ renderer に返す（鍵が renderer メモリに留まらない）。
4. **MCP は renderer 直叩き**：MCP には鍵が要らず低レイテンシが価値なので、IPC 経由でなく renderer から `fetch()`。Host ヘッダは fetch 既定で `127.0.0.1:4820` になるためサーバの loopback 検証を通る。
5. **会話履歴は localStorage**：DB なし。複雑な永続化が要れば SQLite (better-sqlite3) を main 側に置く拡張余地あり。

---

## 6. 残作業ロードマップ

### 短期（v0.2 候補）
- **接続自動再試行**：Ardour 起動中の sleep/wake やセッション切替で接続が切れたら自動 reconnect。
- **ツール選別 UI**：96 全 tools を毎回送ると Anthropic 側で `system` トークン消費が大きい。カテゴリ（transport/track/region…）でフィルタ可能に。
- **複数会話タブ**：左サイドバーで会話切替。
- **エクスポート**：会話を Markdown / JSON に書き出し。

### 中期（v0.3）
- **画像入力**：Ardour の screenshot ツール（存在すれば）を tool として渡し、Claude に渡す。
- **ストリーミング応答**：Anthropic SDK の `messages.stream()` でリアルタイム描画。
- **Codex 風ステップ詳細**：ツール実行カードに「予想 / 実行 / 観測」セクション。
- **トランザクション境界**：Ardour 側で `begin_batch`/`commit_batch` が実装されたら、本クライアントも「ターン＝1 Undo」のオプションを露出。

### 長期（v1.0）
- **`mcp-remote` 互換**：Claude Desktop と同じ「MCP-over-stdio で外部プロセス」モードもサポート（HTTP 直叩きに加えて）。
- **Distribution**：`electron-builder` または `electron-forge` で署名済み `.app` / `.dmg` パッケージ。Code-sign + notarize。
- **テレメトリなし** を売りに（Ardour と整合）。

### Phase アライメント（Ardour ロードマップとの対応）
Ardour 側 `MCP_LLM_CONTROL_HANDOFF.md` の Phase 2（SSE/notifications）が実装されたら、本クライアントも「サーバ起点の状態通知」を受信して UI に反映する機能を足す（現在は polling 不要なので接続後は静かなまま）。

---

## 7. 既知の制約・落とし穴

1. **Ardour 未起動時の UX**：Connect ボタンで ECONNREFUSED を出して赤ドット。エラーメッセージは出るが「次にどうすべきか」のヒントを充実させる余地あり（Phase 3 改善候補）。
2. **Anthropic API レート制限**：rate_limit_error / overloaded_error を `lib/agent-loop.js` で検出して 1 回だけ自動再試行するロジックは入っている（指数バックオフ簡易版）。本格運用なら別途強化。
3. **長文応答のクリッピング**：`max_tokens: 4096` 固定。プラグイン一覧 dump 等で切れる可能性。設定可能化が将来の追加項目。
4. **macOS の Quartz 描画**：`nohup` 等の TTY 無しバックグラウンド起動だと Electron ウィンドウが描画されない（Ardour 側でも同じ症状を確認）。普通に Finder / `npm start` で起動すれば OK。
5. **マルチセッション**：1 つの Anthropic アカウント × 1 つの Ardour インスタンスを想定。同時に複数 Ardour を制御するには endpoint URL を会話単位に持つ拡張が必要。
6. **`.env` ファイルの取り扱い**：本リポでは `.env` を `.gitignore` 済み。**絶対に git に入れない**こと。実装初版で誤って `.env` が一時的にコミットされたが、push 前に squash で完全除去済み（履歴に残っていない）。

---

## 8. セキュリティ要点

- **APIキー**：renderer プロセスに渡さず main のみで保持・呼び出し。設定ファイル `settings.json` は `app.getPath('userData')` 配下（macOS なら `~/Library/Application Support/ardour-mcp-companion/settings.json`）。
- **MCP エンドポイント**：loopback 固定（サーバ側 `127.0.0.1` bind + Host ヘッダ検証）。同 LAN の他ホストから本クライアントを使う場合は、Ardour 側のサーフェスを bind 緩和するか SSH トンネル経由を想定（推奨はトンネル）。
- **ツール実行の許可**：v0.1 は **全ツール無条件実行**。Phase 4（破壊的操作の confirm ダイアログ）は将来追加。それまでは Ardour 側の `session/quick_snapshot` を最初に手動で打つ運用を推奨。
- **Renderer の XSS 回避**：Markdown レンダラは入力を HTML escape してから装飾を適用（`lib/markdown.js`）。ツール出力 JSON は `<pre>` + textContent で直挿入せず escape 経由。

---

## 9. 検証履歴

| 検証 | 結果 | 詳細 |
|---|---|---|
| `node --check` 全 JS | ✅ | main, preload, renderer, lib/* すべて構文 OK |
| `@anthropic-ai/sdk` 解決 | ✅ | v0.32.0 が `require()` で取れる |
| `lib/mcp-client.js` 単体 | ✅ | ECONNREFUSED 時の例外パス確認、Ardour 起動時の serverInfo + 96 tools 取得は Wave 2 で実機確認済み |
| Electron 起動 | ✅ | `npx electron .` が SIGTERM タイムアウトまでクラッシュなし |
| git tree | ✅ | 14 tracked files、`.env` 履歴なし、`.gitignore` 完備 |

---

## 10. 着手の最初の 30 分（次の LLM 向け）

1. `npm install && npm start` で起動。Settings → API key 入力。
2. 別ターミナルで Ardour（masatomoota/ardour `feature/mcp-fresh-macos`、`MCP_LLM_CONTROL_HANDOFF.md` §3 手順）を起動 → Preferences で MCP HTTP サーフェス ON。
3. クライアント側 Connect。緑ドット＋ "96 tools" 表示を確認。
4. テスト送信：「現在のトランスポート状態を教えて」→ Claude が `transport/get_state` または `transport_get_state` を呼び、結果が表示されるはず。
5. うまく動かなければ DevTools (Cmd+Opt+I) で renderer のエラー / main プロセスログを確認。

---

## 11. リポ情報・連絡

- **本リポ**: https://github.com/masatomoota/ardour-mcp-chat（MIT）
- **対の Ardour リポ**: https://github.com/masatomoota/ardour（GPLv2-or-later、`feature/mcp-fresh-macos` ブランチ）
- **並行する Audacity 構想**: https://github.com/masatomoota/audacity（`mcp-llm-handoff` ブランチに同種の handoff doc）
- **設計レポート 4 部**（PDF）: 作業ホスト `/Volumes/work-ssd-4TB-USB4/_Git_Repository/llm-daw-report/`（Ardour 改造可能性調査・MCP 是正実装プラン v2・Audacity 改造可能性レビュー・ライセンス・コンプライアンス）。本ハンドオフはこれらに依存せず単体で完結。

---

*End of handoff. 次の LLM へ：§3 で疎通を再現確認 → §6 のロードマップから次の山を 1 つ選んで着手。短期なら接続自動再試行か、ツール選別 UI が手堅い。中期なら ストリーミング応答が体感の差が大きい。長期は配布（電子署名 .app 化）が価値高い。*
