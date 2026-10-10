// PLAN.md S3.2 / D4: prompt namespacing `<server>_<name>`.
//
// D4's rule about over-long names is stated for tools. It is applied to prompts too, so a
// prompt can never produce a name a client would reject; the reason string is reused.

import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import { namespaceBatch, parseNamespacedName } from './namespace.js';
import type { Prompt } from '@modelcontextprotocol/server';

export interface AggregatedPromptsList {
  prompts: Prompt[];
}

/** Applies D4 to a prompt batch, exactly as for tools. */
export function aggregatePrompts(
  entries: readonly { server: string; name: string; prompt: Prompt }[],
): { prompts: Prompt[]; skipped: { server: string; tool: string; reason: string }[] } {
  const { tools: namespaced, report } = namespaceBatch(
    entries.map((e) => ({ server: e.server, name: e.name })),
  );
  const byKey = new Map<string, Prompt>();
  for (const entry of entries) byKey.set(`${entry.server}\u0000${entry.name}`, entry.prompt);

  const prompts = namespaced.map((entry) => {
    const original = byKey.get(`${entry.server}\u0000${entry.name}`);
    if (original === undefined) {
      throw new Error(`internal: lost the prompt definition for ${entry.namespaced}`);
    }
    return { ...original, name: entry.namespaced };
  });

  prompts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { prompts, skipped: report.skipped };
}

/** S3.2: an unknown namespaced prompt is a protocol error, matching D12's split. */
export function unknownPrompt(name: string): ProtocolError {
  return new ProtocolError(INVALID_PARAMS, `Unknown prompt: ${name}`);
}

export { parseNamespacedName };