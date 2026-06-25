'use strict';

const MAX_ITERATIONS = 20;

/**
 * AgentLoop — drives the Claude <-> MCP tool-use loop.
 *
 * Options:
 *   llmClient  — object with async createMessage(params) -> Anthropic response
 *   mcpClient  — McpClient instance (already initialized)
 *   model      — Claude model string
 *   systemPrompt — string
 *   onEvent    — callback(event) where event has .type and other fields
 */
class AgentLoop {
  constructor({ llmClient, mcpClient, model, systemPrompt, onEvent }) {
    this.llmClient = llmClient;
    this.mcpClient = mcpClient;
    this.model = model || 'claude-sonnet-4-6';
    this.systemPrompt = systemPrompt || '';
    this.onEvent = onEvent || (() => {});
    this.messages = [];
    this._tools = null; // cached mapped tools
  }

  // -----------------------------------------------------------------------
  // Map an MCP tool descriptor to Anthropic tool shape.
  // -----------------------------------------------------------------------
  mapMcpToolToAnthropic(t) {
    return {
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    };
  }

  // -----------------------------------------------------------------------
  // Ensure we have tools list (lazy fetch).
  // -----------------------------------------------------------------------
  async _getTools() {
    if (this._tools) return this._tools;
    try {
      const raw = await this.mcpClient.listTools();
      this._tools = raw.map((t) => this.mapMcpToolToAnthropic(t));
    } catch (err) {
      this._tools = [];
    }
    return this._tools;
  }

  // -----------------------------------------------------------------------
  // Send a user message and run the agentic loop.
  // -----------------------------------------------------------------------
  async sendUser(text) {
    this.messages.push({ role: 'user', content: text });
    await this.runLoop();
  }

  // -----------------------------------------------------------------------
  // Core loop.
  // -----------------------------------------------------------------------
  async runLoop() {
    const tools = await this._getTools();

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let response;
      try {
        response = await this.llmClient.createMessage({
          model: this.model,
          max_tokens: 4096,
          system: this.systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          messages: this.messages,
        });
      } catch (err) {
        this.onEvent({ type: 'error', message: err.message || String(err) });
        return;
      }

      const assistantContent = response.content || [];

      // Emit events for each content block before deciding what to do.
      for (const block of assistantContent) {
        if (block.type === 'text') {
          this.onEvent({ type: 'assistant-text', text: block.text });
        } else if (block.type === 'tool_use') {
          this.onEvent({
            type: 'tool-use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      if (response.stop_reason !== 'tool_use') {
        // Final answer — append assistant turn and stop.
        this.messages.push({ role: 'assistant', content: assistantContent });
        return;
      }

      // Append assistant turn with tool_use blocks.
      this.messages.push({ role: 'assistant', content: assistantContent });

      // Execute every tool_use block and collect tool_result blocks.
      const toolResultBlocks = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        let resultContent;
        let ok = true;

        try {
          const mcpResult = await this.mcpClient.callTool(block.name, block.input);
          // Serialize result to string for the tool_result content.
          if (mcpResult && mcpResult.content && Array.isArray(mcpResult.content)) {
            // Try to get text from MCP content blocks.
            const textParts = mcpResult.content
              .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
              .join('\n');
            resultContent = textParts || JSON.stringify(mcpResult);
          } else {
            resultContent = JSON.stringify(mcpResult);
          }
        } catch (err) {
          ok = false;
          resultContent = `Error: ${err.message}`;
        }

        this.onEvent({
          type: 'tool-result',
          id: block.id,
          ok,
          output: resultContent,
        });

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultContent,
        });
      }

      // Append a single user message with all tool results.
      this.messages.push({ role: 'user', content: toolResultBlocks });
    }

    // Safety: exceeded max iterations.
    this.onEvent({
      type: 'error',
      message: `Agent loop exceeded ${MAX_ITERATIONS} iterations and was stopped.`,
    });
  }
}

module.exports = AgentLoop;
