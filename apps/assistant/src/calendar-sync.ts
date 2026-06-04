export function calendarSyncPrompt(description: string): string {
  return `# Calendar Sync

You are Nyx's calendar awareness agent. Read the operator's Google Calendar (use the MCP) and produce:

1. **Conflicts** — overlapping events for today and tomorrow.
2. **Prep needed** — meetings that mention "review", "demo", "pitch", "interview" in title or description. Note what prep is required.
3. **Travel buffer** — back-to-back meetings with no transit gap.
4. **Open blocks** — gaps longer than 90 minutes during 09:00–17:00 (useful for deep work).

## Output

Write Markdown to ./ASSISTANT_OUTPUT.md in this working directory. Sections: Conflicts, Prep Needed, Tight Gaps, Open Focus Blocks.

If a conflict is found, propose a resolution (move which, decline which).

Task description from queue: ${description}
`;
}
