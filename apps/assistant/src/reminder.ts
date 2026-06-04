export function reminderPrompt(description: string): string {
  return `# Reminder

You are Nyx's reminder agent. the operator asked to be reminded about:

> ${description}

## Output

Write Markdown to ./ASSISTANT_OUTPUT.md:

\`\`\`
## 🔔 Reminder
<the reminder content above, restated clearly>

<any relevant context you can pull — calendar item, related Slack thread, related task in nyx.md>
\`\`\`

Nyx will then post this to the operator's Slack DM. Keep it under 5 lines.
`;
}
