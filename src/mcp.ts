#!/usr/bin/env -S NODE_NO_WARNINGS=1 node
// memoir MCP server (stdio). Claude/clients spawn this as a local subprocess and
// talk over stdin/stdout — no network, no hosting. It exposes the same local
// Memoir over the same .memoir/memory.db, so a fresh session can open the brain
// on its own.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Memoir } from './memoir.ts';
import { MEMORY_TYPES, isMemoryType, type Memory } from './types.ts';

// stdout is the JSON-RPC channel for stdio transport — nothing else may touch it.
// Route any stray library logging to stderr so it can't corrupt the protocol.
console.log = (...args) => console.error(...args);

const INSTRUCTIONS = `memoir is this codebase's long-term memory — a local store of facts you could NOT reconstruct from the code itself: the why, the don't, the not-yet, and how this user likes to work.

At the START of a session (or when picking up unfamiliar work), call \`recall\` with a natural-language query to load relevant context before acting.

As you work, call \`remember\` to capture anything durable, choosing a type:
- decision (why X over Y, incl. rejected options)
- convention (implicit rules to stay consistent)
- gotcha (landmines, fragile/flaky code, "don't")
- constraint (hard boundaries)
- glossary (what a domain term means here)
- state (what's in-flight right now)
- preference (how this user likes to work)

Pin memories to code with \`anchors\` (files/modules/symbols). When a new fact replaces an old one, pass the old memory's id(s) via \`supersedes\` so memory stays coherent instead of accumulating contradictions. Do not store what the code or git already says.`;

const mem = Memoir.open();

function fmt(m: Memory): string {
  const head = `[${m.type}] ${m.id.slice(0, 8)}`;
  const meta = [
    m.anchors.length ? `@ ${m.anchors.join(' ')}` : '',
    m.tags.length ? `# ${m.tags.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('  ');
  return `${head}\n${m.content}${meta ? `\n${meta}` : ''}`;
}

const server = new McpServer({ name: 'memoir', version: '0.0.1' }, { instructions: INSTRUCTIONS });

server.registerTool(
  'recall',
  {
    title: 'Recall memories',
    description:
      'Search this codebase\'s memory for facts relevant to a query (hybrid keyword + semantic). Call before working to load context.',
    inputSchema: {
      query: z.string().describe('What you want to remember about, in natural language'),
      limit: z.number().int().positive().max(50).optional(),
      type: z.string().optional().describe(`Optional filter, one of: ${MEMORY_TYPES.join(', ')}`),
    },
  },
  async ({ query, limit, type }) => {
    const t = type && isMemoryType(type) ? type : undefined;
    const results = await mem.recall(query, { limit: limit ?? 5, type: t });
    const text = results.length ? results.map(fmt).join('\n\n') : 'No relevant memories.';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'remember',
  {
    title: 'Remember a fact',
    description:
      'Store one atomic fact you could NOT reconstruct from the code — a decision, convention, gotcha, constraint, glossary term, in-flight state, or user preference.',
    inputSchema: {
      content: z.string().describe('The fact, in natural language'),
      type: z.string().describe(`One of: ${MEMORY_TYPES.join(', ')}`),
      anchors: z.array(z.string()).optional().describe('Files/modules/symbols this is about'),
      tags: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional().describe('Ids (full or short) this fact replaces'),
    },
  },
  async ({ content, type, anchors, tags, supersedes }) => {
    if (!isMemoryType(type)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid type. Use one of: ${MEMORY_TYPES.join(', ')}` }],
      };
    }
    const { memory, superseded, embedded } = await mem.remember({
      content,
      type,
      anchors,
      tags,
      supersedes,
    });
    const note = superseded.length ? ` (superseded ${superseded.length})` : '';
    const emb = embedded ? '' : ' [keyword-only]';
    return {
      content: [{ type: 'text', text: `Remembered ${memory.id.slice(0, 8)} [${memory.type}]${note}${emb}` }],
    };
  },
);

server.registerTool(
  'list',
  {
    title: 'List recent memories',
    description: 'List the most recently updated memories, optionally filtered by type.',
    inputSchema: {
      limit: z.number().int().positive().max(100).optional(),
      type: z.string().optional().describe(`Optional filter, one of: ${MEMORY_TYPES.join(', ')}`),
    },
  },
  async ({ limit, type }) => {
    const t = type && isMemoryType(type) ? type : undefined;
    const all = mem.list({ limit: limit ?? 20, type: t });
    const text = all.length ? all.map(fmt).join('\n\n') : 'No memories yet.';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'forget',
  {
    title: 'Forget a memory',
    description: 'Permanently delete a memory by id (full or short prefix). Prefer `supersedes` on remember for facts that changed; use forget only for genuinely wrong entries.',
    inputSchema: { id: z.string().describe('The memory id (full or 8-char short prefix)') },
  },
  async ({ id }) => {
    const ok = mem.forget(id);
    return { content: [{ type: 'text', text: ok ? `Forgot ${id}` : `No memory matching ${id}` }] };
  },
);

// Warm the embedder before opening the protocol: confines any one-time
// model-load logging to startup (stdout must stay clean once connected) and
// makes the first recall/remember fast.
await mem.warm();

const transport = new StdioServerTransport();
await server.connect(transport);
