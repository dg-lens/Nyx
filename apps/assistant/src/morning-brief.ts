export function morningBriefPrompt(description: string): string {
  return `# Morning Brief

You are Nyx's morning briefing agent. Build a structured daily brief for the operator covering:

1. **Today's calendar** — Google Calendar (use the MCP). List events in chronological order with time, title, and any flagged prep notes.
2. **Slack overview** — unread DMs and important channel mentions overnight. Use the Slack MCP. Summarize, do not paste.
3. **Inbox highlights** — top 3-5 emails needing attention (use Gmail MCP). Flag anything from investors, customers, or partners.
4. **Nyx queue status** — if a \`QUEUE_STATUS.md\` file is present in this working directory, read it and summarize: count active tasks, note any completed or failed since yesterday. If that file is not present, write "Queue status unavailable this run." — do NOT attempt to read the queue from any path outside this working directory (you have no shell and no access beyond it).
5. **Followups** — overdue reminders, blocked PRs, or anything Nyx noticed in audit history.

## Output

Write the brief as Markdown to ./ASSISTANT_OUTPUT.md in this working directory. Structure:

\`\`\`
## ☕ Brief — <date>

### Calendar
...

### Slack
...

### Inbox
...

### Nyx
- N active tasks (or "Queue status unavailable this run.")
- Completed since yesterday: ...
- Failures: ...

### Followups
- ...
\`\`\`

Keep it tight — the operator reads this on his phone over coffee. Skip filler.

Task description from queue: ${description}
`;
}
