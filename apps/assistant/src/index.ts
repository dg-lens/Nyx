export { morningBriefPrompt } from './morning-brief.js';
export { calendarSyncPrompt } from './calendar-sync.js';
export { reminderPrompt } from './reminder.js';
export { slackDigestPrompt } from './slack-digest.js';
export { inboxTriagePrompt } from './inbox-triage.js';
export { rotationCheckPrompt } from './rotation-check.js';
export { digestSalesPrompt, digestMarketingPrompt, digestOpsPrompt } from './digest.js';
export { briefCompetitorPrompt, briefProspectPrompt, briefMarketPrompt } from './brief.js';
export { draftOutreachPrompt, draftFollowupPrompt, draftReleaseNotesPrompt, draftSocialPrompt } from './draft.js';
export { triageSlackPrompt, triageNotionPrompt, triageAllPrompt } from './triage.js';
export { deckInvestorUpdatePrompt, docWeeklyReportPrompt, sheetPipelineExportPrompt } from './document.js';
export { meetingPrepPrompt, meetingFollowupPrompt } from './meeting.js';
export { watchDepsPrompt, watchDeadcodePrompt, watchCostPrompt } from './watch.js';

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
import { digestSalesPrompt, digestMarketingPrompt, digestOpsPrompt } from './digest.js';
import { briefCompetitorPrompt, briefProspectPrompt, briefMarketPrompt } from './brief.js';
import { draftOutreachPrompt, draftFollowupPrompt, draftReleaseNotesPrompt, draftSocialPrompt } from './draft.js';
import { triageSlackPrompt, triageNotionPrompt, triageAllPrompt } from './triage.js';
import { deckInvestorUpdatePrompt, docWeeklyReportPrompt, sheetPipelineExportPrompt } from './document.js';
import { meetingPrepPrompt, meetingFollowupPrompt } from './meeting.js';
import { watchDepsPrompt, watchDeadcodePrompt, watchCostPrompt } from './watch.js';

export const REGISTRY: Record<string, (desc: string) => string> = {
  'MORNING-BRIEF':  morningBriefPrompt,
  'CALENDAR-SYNC':  calendarSyncPrompt,
  'REMINDER':       reminderPrompt,
  'SLACK-DIGEST':   slackDigestPrompt,
  'INBOX-TRIAGE':   inboxTriagePrompt,
  'ROTATION-CHECK': rotationCheckPrompt,

  'DIGEST-SALES':          digestSalesPrompt,
  'DIGEST-MARKETING':      digestMarketingPrompt,
  'DIGEST-OPS':            digestOpsPrompt,

  'BRIEF-COMPETITOR':      briefCompetitorPrompt,
  'BRIEF-PROSPECT':        briefProspectPrompt,
  'BRIEF-MARKET':          briefMarketPrompt,

  'DRAFT-OUTREACH':        draftOutreachPrompt,
  'DRAFT-FOLLOWUP':        draftFollowupPrompt,
  'DRAFT-RELEASE-NOTES':   draftReleaseNotesPrompt,
  'DRAFT-SOCIAL':          draftSocialPrompt,

  'TRIAGE-SLACK':          triageSlackPrompt,
  'TRIAGE-NOTION':         triageNotionPrompt,
  'TRIAGE-ALL':            triageAllPrompt,

  'DECK-INVESTOR-UPDATE':  deckInvestorUpdatePrompt,
  'DOC-WEEKLY-REPORT':     docWeeklyReportPrompt,
  'SHEET-PIPELINE-EXPORT': sheetPipelineExportPrompt,

  'MEETING-PREP':          meetingPrepPrompt,
  'MEETING-FOLLOWUP':      meetingFollowupPrompt,

  'WATCH-DEPS':            watchDepsPrompt,
  'WATCH-DEADCODE':        watchDeadcodePrompt,
  'WATCH-COST':            watchCostPrompt,
};

/**
 * SINGLE SOURCE OF TRUTH for which task type each template family applies to.
 * The Swift Dispatch picker mirrors this map (see desktop DispatchView.swift),
 * the task-reader validates [template:] tags against it, and the decomposer
 * plumbing relies on it. Keep it in lockstep with REGISTRY: every key here MUST
 * exist in REGISTRY and vice-versa (the registry test enforces both directions).
 *
 *   - 'assistant' families: the MCP/inbox/brief/triage/meeting/watch/digest set.
 *   - 'content' families: DRAFT-* / DECK-* / DOC-* / SHEET-* — written copy.
 *
 * code/analysis/pipeline have NO templates today, so they appear in neither
 * value set; a [template:] on those types is always a type mismatch.
 */
export type TemplateTaskType = 'assistant' | 'content';

export const TEMPLATE_TYPES: Record<string, TemplateTaskType> = {
  'MORNING-BRIEF':  'assistant',
  'CALENDAR-SYNC':  'assistant',
  'REMINDER':       'assistant',
  'SLACK-DIGEST':   'assistant',
  'INBOX-TRIAGE':   'assistant',
  'ROTATION-CHECK': 'assistant',

  'DIGEST-SALES':     'assistant',
  'DIGEST-MARKETING': 'assistant',
  'DIGEST-OPS':       'assistant',

  'BRIEF-COMPETITOR': 'assistant',
  'BRIEF-PROSPECT':   'assistant',
  'BRIEF-MARKET':     'assistant',

  'TRIAGE-SLACK':  'assistant',
  'TRIAGE-NOTION': 'assistant',
  'TRIAGE-ALL':    'assistant',

  'MEETING-PREP':     'assistant',
  'MEETING-FOLLOWUP': 'assistant',

  'WATCH-DEPS':     'assistant',
  'WATCH-DEADCODE': 'assistant',
  'WATCH-COST':     'assistant',

  'DRAFT-OUTREACH':      'content',
  'DRAFT-FOLLOWUP':      'content',
  'DRAFT-RELEASE-NOTES': 'content',
  'DRAFT-SOCIAL':        'content',

  'DECK-INVESTOR-UPDATE':  'content',
  'DOC-WEEKLY-REPORT':     'content',
  'SHEET-PIPELINE-EXPORT': 'content',
};

/** True iff `id` is a known template family id (exact match, not prefix). */
export function isTemplateId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_TYPES, id);
}

/** The task type a template family applies to, or null for an unknown id. */
export function templateTypeOf(id: string): TemplateTaskType | null {
  return TEMPLATE_TYPES[id] ?? null;
}

export function findTemplate(taskId: string): ((desc: string) => string) | null {
  if (REGISTRY[taskId]) return REGISTRY[taskId];
  for (const key of Object.keys(REGISTRY)) {
    if (taskId.startsWith(key)) return REGISTRY[key] ?? null;
  }
  return null;
}
