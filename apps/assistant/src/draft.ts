interface DraftKind {
  title: string;
  deliverable: string;
  outputFile: string;
  tokens: string[];
  guidance: string;
}

function draftPrompt(d: DraftKind, description: string): string {
  const tokenList = d.tokens.map((t) => `- \`<${t}>\``).join('\n');
  return `# ${d.title}

You are Nyx's ${d.deliverable} drafting agent. You produce a **draft only** — the operator (a human) reviews and sends. You NEVER send, post, or commit anything; you have no send capability and must not simulate one.

## Bounded-fill contract (read carefully)

The operator supplies a human-authored template — either inline in the task description or as a file in this working directory. Your job is mechanical and narrow:

- Fill **only** the labelled slots, written as \`<TokenName>\` placeholders. Typical slots for this deliverable:
${tokenList}
- Fill **3 to 5 slots maximum**. If the template has more, fill the most clearly determined ones and leave the rest as \`<TokenName>\` for the human.
- **LOCKED — do not touch:** every claim, number, statistic, price, date, commitment, and the overall tone/voice are human-authored and frozen. You do not invent figures, soften or sharpen claims, restructure sentences, or "improve" the copy. If a slot would require inventing a fact or number you were not given, leave it as \`<TokenName>\` and flag it.
- If no human template is provided, do NOT compose one from scratch. Write a short note explaining a template is required and stop.

${d.guidance}

## Output

Write the filled draft to \`${d.outputFile}\` in this working directory. Begin the file with a single line:

\`\`\`
DRAFT — review before sending. <N> slots filled, <M> left for you: <list any unfilled tokens>.
\`\`\`

Then the deliverable body. Do not add commentary inside the deliverable itself.

Task description from queue: ${description}
`;
}

export function draftOutreachPrompt(description: string): string {
  return draftPrompt(
    {
      title: 'Draft Outreach',
      deliverable: 'cold/warm outreach message',
      outputFile: './outreach-draft.md',
      tokens: ['RecipientName', 'Company', 'Hook', 'CTA', 'SenderName'],
      guidance:
        '## Notes\n\nThis is a first-touch message. The value proposition and any claims are the human\'s — you only personalize the named slots so the message reads as addressed to this specific recipient.',
    },
    description,
  );
}

export function draftFollowupPrompt(description: string): string {
  return draftPrompt(
    {
      title: 'Draft Follow-up',
      deliverable: 'follow-up message',
      outputFile: './followup-draft.md',
      tokens: ['RecipientName', 'LastTouchContext', 'NextStep', 'Date', 'SenderName'],
      guidance:
        '## Notes\n\nThis follows a prior interaction. Fill the context-of-last-touch and next-step slots from what the task description tells you — do not assume facts about the prior conversation you were not given.',
    },
    description,
  );
}

export function draftReleaseNotesPrompt(description: string): string {
  return draftPrompt(
    {
      title: 'Draft Release Notes',
      deliverable: 'release notes',
      outputFile: './release-notes-draft.md',
      tokens: ['Version', 'Highlight', 'ShipDate', 'UpgradeNote', 'Audience'],
      guidance:
        '## Notes\n\nThe feature list, version number, and any breaking-change wording are human-authored. Fill only the labelled framing slots. Never invent a feature, a version, or a date that was not given to you.',
    },
    description,
  );
}

export function draftSocialPrompt(description: string): string {
  return draftPrompt(
    {
      title: 'Draft Social Post',
      deliverable: 'social post',
      outputFile: './social-draft.md',
      tokens: ['Topic', 'Hook', 'Link', 'Handle', 'CallToAction'],
      guidance:
        '## Notes\n\nMatch the operator\'s human-authored voice exactly — do not add hashtags, emoji, or hype the template does not already use. If a character limit is named in the task, respect it; otherwise leave length to the human template.',
    },
    description,
  );
}
