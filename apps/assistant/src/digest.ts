interface DigestRole {
  title: string;
  audience: string;
  focus: string[];
  channels: string;
}

function digestPrompt(role: DigestRole, description: string): string {
  const focusList = role.focus.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return `# ${role.title}

You are Nyx's role-scoped daily digest agent for the ${role.audience}. Build a tight, phone-readable roll-up of what happened across the operator's tools, filtered to what matters for this role.

Pull from these sources (each via its MCP). Cover them in this order:

${focusList}

## MCP resilience

Each source is a separate MCP and any one may be unavailable this run. If an MCP errors or returns nothing, do NOT abort the digest — write a single line "MCP ${role.channels} unavailable; continuing." under that section's heading and move on. A partial digest is the goal; a failed run is not. Never invent activity you could not actually read.

## Scope discipline

This is a ${role.audience} digest, not a firehose. Drop anything outside the role's concern. Summarize, never paste raw threads or full email bodies. One line per item: who / what / why-it-matters.

## Output

Write Markdown to ./ASSISTANT_OUTPUT.md in this working directory. The operator reads this on his phone — lead with the single most important item, keep each section to its top 3-5, skip filler, no "I noticed" or apologies.

\`\`\`
## ${role.title} — <date>

### <section per source above>
- <who> · <what> — <why it matters>
\`\`\`

If a whole section is empty after a successful read, write "Nothing notable." under it rather than omitting the heading.

Task description from queue: ${description}
`;
}

export function digestSalesPrompt(description: string): string {
  return digestPrompt(
    {
      title: 'Sales Digest',
      audience: 'sales role',
      focus: [
        '**Deal motion** — Slack threads in sales/deal channels and any @-mentions about pipeline, demos, contracts, or pricing. Use the Slack MCP.',
        '**Customer & prospect email** — Gmail threads from prospects, customers, or partners moving a deal forward. Use the Gmail MCP. Flag anything dated or awaiting the operator.',
        '**CRM / pipeline notes** — relevant Notion pages or databases tracking deals, accounts, or pipeline stages. Use the Notion MCP. Note status changes since yesterday.',
        '**Sales calendar** — today and tomorrow: demos, discovery calls, customer meetings. Use the Calendar MCP. Flag any that need prep.',
      ],
      channels: 'source',
    },
    description,
  );
}

export function digestMarketingPrompt(description: string): string {
  return digestPrompt(
    {
      title: 'Marketing Digest',
      audience: 'marketing role',
      focus: [
        '**Campaign & content motion** — Slack threads in marketing/content/growth channels and @-mentions about launches, campaigns, copy, or analytics. Use the Slack MCP.',
        '**Press, partners & inbound** — Gmail threads about press, partnerships, events, or inbound interest. Use the Gmail MCP. Flag anything time-sensitive.',
        '**Content & campaign docs** — relevant Notion pages tracking the content calendar, campaign briefs, or launch checklists. Use the Notion MCP. Note what shipped or slipped since yesterday.',
        '**Marketing calendar** — today and tomorrow: launches, webinars, content deadlines, partner calls. Use the Calendar MCP. Flag prep needed.',
      ],
      channels: 'source',
    },
    description,
  );
}

export function digestOpsPrompt(description: string): string {
  return digestPrompt(
    {
      title: 'Ops Digest',
      audience: 'operations role',
      focus: [
        '**Operational signal** — Slack threads in ops/eng/incident/support channels and @-mentions about outages, blockers, on-call, or process. Use the Slack MCP. Surface anything that looks like an incident first.',
        '**Vendor & admin email** — Gmail threads about billing, vendors, infra providers, legal, or compliance. Use the Gmail MCP. Flag deadlines and renewals.',
        '**Runbooks & trackers** — relevant Notion pages tracking ops processes, incident logs, or task boards. Use the Notion MCP. Note status changes since yesterday.',
        '**Ops calendar** — today and tomorrow: standups, vendor calls, maintenance windows, reviews. Use the Calendar MCP. Flag conflicts.',
      ],
      channels: 'source',
    },
    description,
  );
}
