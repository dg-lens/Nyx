export { morningBriefPrompt } from './morning-brief.js';
export { calendarSyncPrompt } from './calendar-sync.js';
export { reminderPrompt } from './reminder.js';
export { slackDigestPrompt } from './slack-digest.js';
export { inboxTriagePrompt } from './inbox-triage.js';
export { rotationCheckPrompt } from './rotation-check.js';

export interface AssistantPrompt {
  id: string;
  build(description: string): string;
}

import { morningBriefPrompt } from './morning-brief.js';
import { calendarSyncPrompt } from './calendar-sync.js';
import { reminderPrompt } from './reminder.js';
import { slackDigestPrompt } from './slack-digest.js';
import { inboxTriagePrompt } from './inbox-triage.js';
import { rotationCheckPrompt } from './rotation-check.js';

export const REGISTRY: Record<string, (desc: string) => string> = {
  'MORNING-BRIEF':  morningBriefPrompt,
  'CALENDAR-SYNC':  calendarSyncPrompt,
  'REMINDER':       reminderPrompt,
  'SLACK-DIGEST':   slackDigestPrompt,
  'INBOX-TRIAGE':   inboxTriagePrompt,
  'ROTATION-CHECK': rotationCheckPrompt,
};

export function findTemplate(taskId: string): ((desc: string) => string) | null {
  if (REGISTRY[taskId]) return REGISTRY[taskId];
  for (const key of Object.keys(REGISTRY)) {
    if (taskId.startsWith(key)) return REGISTRY[key] ?? null;
  }
  return null;
}
