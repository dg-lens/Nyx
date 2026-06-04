import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { parseMcpList } from '../src/mcp-discovery.js';

describe('parseMcpList', () => {
  test('parses claude mcp list output into mcp__<server> entries', () => {
    const sample = `Checking MCP server health…

claude.ai Slack: https://mcp.slack.com/mcp - ✓ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✓ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✓ Connected
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Notion: https://mcp.notion.com/mcp - ✓ Connected
Sanity: https://mcp.sanity.io (HTTP) - ✓ Connected
`;
    const out = parseMcpList(sample);
    assert.deepEqual(out, [
      'mcp__claude_ai_Slack',
      'mcp__claude_ai_Gmail',
      'mcp__claude_ai_Google_Drive',
      'mcp__claude_ai_Google_Calendar',
      'mcp__claude_ai_Notion',
      'mcp__Sanity',
    ]);
  });

  test('skips non-mcp lines and the health banner', () => {
    const sample = `Checking MCP server health…
random garbage
something else: not-a-url - status
`;
    assert.deepEqual(parseMcpList(sample), []);
  });

  test('returns empty on empty input', () => {
    assert.deepEqual(parseMcpList(''), []);
  });

  test('handles unauthenticated MCPs (still listed)', () => {
    const sample = `claude.ai Foo: https://example.com - ! Needs authentication\n`;
    assert.deepEqual(parseMcpList(sample), ['mcp__claude_ai_Foo']);
  });
});
