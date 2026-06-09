interface TriageSource {
  title: string;
  surface: string;
  mcp: string;
  itemNoun: string;
  draftNote: string;
}

function triagePrompt(t: TriageSource, description: string): string {
  return `# ${t.title}

You are Nyx's ${t.surface} triage agent. Read the operator's ${t.surface} (${t.mcp}) and sort unread/recent ${t.itemNoun} into four buckets.

## Buckets

- **Urgent** — needs the operator today. Escalations, time-boxed asks, anything dated within 24h, anything from a customer/investor/partner that cannot wait.
- **Needs Response** — requires the operator personally but is not on fire. Flag where a draft reply would save time.
- **FYI** — relevant context, no action required.
- **Ignorable** — automated notices, noise, newsletters, bot chatter. Count them, do not enumerate.

For each Urgent and Needs-Response item include: source/sender, the subject or thread, and a one-sentence ask.

## Optional drafts

${t.draftNote} When you propose one, mark it \`DRAFT:\` — it is a suggestion the operator reviews and sends. You do NOT send, post, or reply yourself.

## MCP resilience

If ${t.mcp.replace(/^use /, '')} is unavailable this run, write "${t.title}: MCP unavailable; nothing triaged." to the output and exit cleanly rather than failing.

## Output

Write Markdown to ./ASSISTANT_OUTPUT.md in this working directory:

\`\`\`
### Urgent
- <source> · <subject/thread> — <ask>

### Needs Response
- <source> · <subject/thread> — <ask>
  (DRAFT: <proposed reply>)

### FYI
- <source> · <subject/thread>

### Ignorable
- <count> items
\`\`\`

Lead with Urgent. No filler, no "I noticed".

Task description from queue: ${description}
`;
}

export function triageSlackPrompt(description: string): string {
  return triagePrompt(
    {
      title: 'Slack Triage',
      surface: 'Slack',
      mcp: 'use the Slack MCP',
      itemNoun: 'DMs, mentions, and threads',
      draftNote:
        'If a Needs-Response message has an obvious short reply, propose it.',
    },
    description,
  );
}

export function triageNotionPrompt(description: string): string {
  return triagePrompt(
    {
      title: 'Notion Triage',
      surface: 'Notion',
      mcp: 'use the Notion MCP',
      itemNoun: 'pages, comments, and assigned items',
      draftNote:
        'If a comment or assigned item has an obvious short reply or status update, propose it.',
    },
    description,
  );
}

export function triageAllPrompt(description: string): string {
  return `# Unified Triage

You are Nyx's unified triage agent. Sweep the operator's Gmail, Slack, and Notion (each via its MCP) and merge everything into one cross-surface set of four buckets. This is the single triage the operator reads when he wants one list, not three.

## Buckets

- **Urgent** — needs the operator today, from any surface. Escalations, time-boxed asks, anything dated within 24h, anything from a customer/investor/partner that cannot wait.
- **Needs Response** — requires the operator personally but is not on fire. Flag where a draft reply would save time.
- **FYI** — relevant context, no action.
- **Ignorable** — automated notices, noise, newsletters, bot chatter. Count per surface, do not enumerate.

For each Urgent and Needs-Response item include the **surface** (Gmail/Slack/Notion), the sender/source, the subject or thread, and a one-sentence ask. Sort Urgent first, and within a bucket interleave surfaces by importance, not by source.

## Optional drafts

Where a Needs-Response item has an obvious short reply, propose one marked \`DRAFT:\`. It is a suggestion the operator sends himself — you never send, post, or reply.

## MCP resilience

Each surface is a separate MCP and any may be unavailable. If one errors or returns nothing, write a single line "<surface> MCP unavailable; continuing." under the relevant items and triage the surfaces you can reach. A two-surface triage still ships; do not abort the whole run because one MCP is down.

## Output

Write Markdown to ./ASSISTANT_OUTPUT.md in this working directory:

\`\`\`
### Urgent
- [<surface>] <source> · <subject/thread> — <ask>

### Needs Response
- [<surface>] <source> · <subject/thread> — <ask>
  (DRAFT: <proposed reply>)

### FYI
- [<surface>] <source> · <subject/thread>

### Ignorable
- Gmail: <n> · Slack: <n> · Notion: <n>
\`\`\`

Task description from queue: ${description}
`;
}
