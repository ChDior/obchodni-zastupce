import { z } from 'zod';
import type { ToolDefinition } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  register(...defs: ToolDefinition[]) {
    for (const d of defs) {
      if (this.tools.has(d.name)) throw new Error(`Duplicate tool ${d.name}`);
      this.tools.set(d.name, d);
    }
    return this;
  }
  get(name: string) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }
  /** JSON schema pro LLM (function calling). */
  llmSpec(names: string[]) {
    return names.map((n) => {
      const t = this.tools.get(n);
      if (!t) throw new Error(`Unknown tool ${n}`);
      const schema = z.toJSONSchema(t.input) as Record<string, unknown>;
      delete schema.$schema;
      return { name: t.name, description: t.description, parameters: schema };
    });
  }
}
