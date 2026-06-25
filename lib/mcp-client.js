'use strict';

/**
 * McpClient — minimal fetch-based MCP-over-HTTP client.
 * Uses JSON-RPC 2.0 against Ardour's MCP HTTP surface (default 127.0.0.1:4820/mcp).
 * Requires Node 22+ (global fetch available).
 */
class McpClient {
  constructor(url) {
    this.url = url;
    this._id = 0;
    this.serverInfo = null;
  }

  // -----------------------------------------------------------------------
  // Internal: increment id, POST JSON-RPC, return result or throw.
  // -----------------------------------------------------------------------
  async request(method, params) {
    this._id += 1;
    const body = {
      jsonrpc: '2.0',
      id: this._id,
      method,
    };
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

    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();

    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }

    return json.result;
  }

  // -----------------------------------------------------------------------
  // Send a notification (no id, no response expected).
  // -----------------------------------------------------------------------
  async notify(method, params) {
    const body = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) {
      // notifications are fire-and-forget; ignore errors
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Send initialize handshake then notifications/initialized. */
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

  /** Return array of tool descriptors from the server. */
  async listTools() {
    const result = await this.request('tools/list', {});
    return result.tools || [];
  }

  /**
   * Call a named tool with arguments.
   * Returns the result object (has .content[] and/or .structuredContent).
   */
  async callTool(name, args) {
    const result = await this.request('tools/call', {
      name,
      arguments: args || {},
    });
    return result;
  }
}

module.exports = McpClient;
