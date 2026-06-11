import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VALID_KINDS, isValidKind } from '@nyx/dispatcher/dist/memory/arachne.js';
import { IndexCache, vaultDir } from './vault.js';
import {
  loadTool,
  neighborsTool,
  packTool,
  reloadTool,
  searchTool,
  surveyTool,
  validateTool,
  writeTool,
} from './tools.js';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

export function buildServer(cache: IndexCache): McpServer {
  const server = new McpServer({ name: 'arachne', version: '1.2.1' });

  server.registerTool(
    'memory_pack',
    {
      description:
        'Hot path: assemble the smallest scoped context pack (rendered ## MEMORY block) for a task. Inherits the injection-trust gate — review:pending agent nodes are never packed.',
      inputSchema: {
        paths: z.array(z.string()).optional(),
        triggers: z.array(z.string()).optional(),
        repo: z.string().optional(),
        audience: z.string().optional(),
        budget: z.number().int().positive().optional(),
      },
    },
    async (a) => json(packTool(cache, a)),
  );

  server.registerTool(
    'memory_survey',
    {
      description: 'Cheap catalog read: ranked stubs (id,title,summary,kind,loc,weight) for a scope. No bodies.',
      inputSchema: {
        scope: z.string(),
        audience: z.string().optional(),
        budget: z.number().int().positive().optional(),
      },
    },
    async (a) => json(surveyTool(cache, a)),
  );

  server.registerTool(
    'memory_load',
    {
      description: 'Full node bodies for up to 10 ids, sanitized and section-ordered (FIX/CHECK before ANTI).',
      inputSchema: { ids: z.array(z.string()).min(1).max(10) },
    },
    async (a) => json(loadTool(cache, a.ids)),
  );

  server.registerTool(
    'memory_search',
    {
      description:
        'Frontmatter search. review:pending agent nodes ARE returned (discoverability) but each hit carries provenance/review/confidence + an injectable flag.',
      inputSchema: {
        query: z.string().optional(),
        triggers: z.array(z.string()).optional(),
        loc: z.string().optional(),
        concern: z.string().optional(),
        kind: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (a) => json(searchTool(cache, a)),
  );

  server.registerTool(
    'memory_neighbors',
    {
      description: 'Typed edge traversal from a node. Optional rel filter (parent, relates, supersedes, contradicts, depends, ...).',
      inputSchema: { id: z.string(), rel: z.string().optional() },
    },
    async (a) => json(neighborsTool(cache, a.id, a.rel)),
  );

  server.registerTool(
    'memory_write',
    {
      description:
        'Write a node through the classifyWrite dedup/provenance chokepoint. A duplicate/conflict verdict is a structured refusal naming the existing id — NOT written. Only a clean ADD persists.',
      inputSchema: {
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        summary: z.string(),
        body: z.string(),
        loc: z.array(z.string()).optional(),
        concern: z.array(z.string()).optional(),
        load: z.string().optional(),
        audience: z.array(z.string()).optional(),
        weight: z.number().int().optional(),
        paths: z.array(z.string()).optional(),
        triggers: z.array(z.string()).optional(),
      },
    },
    async (a) => {
      if (!isValidKind(a.kind)) {
        return json({
          written: false,
          action: 'REJECT',
          reason: `invalid kind '${a.kind}' — valid kinds: ${[...VALID_KINDS].join(' ')}`,
        });
      }
      return json(writeTool(cache, cache.vault, { ...a, kind: a.kind }));
    },
  );

  server.registerTool(
    'memory_validate',
    {
      description:
        'Corruption detector: walk the vault and report every node that fails to parse (filename + error), plus index-count vs file-count. buildIndex swallows parse failures; this surfaces them.',
      inputSchema: {},
    },
    async () => json(validateTool(cache)),
  );

  server.registerTool(
    'memory_reload',
    {
      description: 'Rebuild the in-process index and return the node count.',
      inputSchema: {},
    },
    async () => json(reloadTool(cache)),
  );

  return server;
}

async function main(): Promise<void> {
  const cache = new IndexCache(vaultDir());
  const server = buildServer(cache);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e: unknown) => {
  console.error('[arachne-mcp] fatal:', (e as Error).message);
  process.exit(1);
});
