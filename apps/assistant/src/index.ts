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

export function findTemplate(taskId: string): ((desc: string) => string) | null {
  if (REGISTRY[taskId]) return REGISTRY[taskId];
  for (const key of Object.keys(REGISTRY)) {
    if (taskId.startsWith(key)) return REGISTRY[key] ?? null;
  }
  return null;
}
