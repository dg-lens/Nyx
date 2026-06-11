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
 * SINGLE SOURCE OF TRUTH for the template families: the task type each applies
 * to, a one-line blurb describing what it produces, and the variable inputs the
 * operator's task description must supply for it.
 *
 * The Swift Dispatch picker mirrors this catalog (see desktop DispatchView.swift
 * — blurb shown on hover, inputs drive the fill-in skeleton), the task-reader
 * validates [template:] tags against it, and the decomposer plumbing relies on
 * it. Keep it in lockstep with REGISTRY: every key here MUST exist in REGISTRY
 * and vice-versa (the registry test enforces both directions).
 *
 *   - 'assistant' families: the MCP/inbox/brief/triage/meeting/watch/digest set.
 *   - 'content' families: DRAFT-* / DECK-* / DOC-* / SHEET-* — written copy.
 *
 * code/analysis/pipeline have NO templates today, so they appear in neither
 * value set; a [template:] on those types is always a type mismatch.
 *
 * `blurb`: one short sentence (<90 chars) — what the template produces, derived
 *   from the template file's actual prompt.
 * `inputs`: the 1-4 variable pieces of info the description must supply, derived
 *   from each build() prompt. Empty for zero-input templates (MORNING-BRIEF etc.)
 *   that read the operator's tools and need nothing typed.
 */
export type TemplateTaskType = 'assistant' | 'content';

export interface TemplateCatalogEntry {
  type: TemplateTaskType;
  blurb: string;
  inputs: string[];
}

export const TEMPLATE_CATALOG: Record<string, TemplateCatalogEntry> = {
  'MORNING-BRIEF': {
    type: 'assistant',
    blurb: 'Daily roll-up of calendar, Slack, inbox, and Nyx queue status.',
    inputs: [],
  },
  'CALENDAR-SYNC': {
    type: 'assistant',
    blurb: 'Flags calendar conflicts, prep-needed meetings, tight gaps, and open focus blocks.',
    inputs: [],
  },
  'REMINDER': {
    type: 'assistant',
    blurb: 'Restates a reminder with any related context and DMs it to you.',
    inputs: ['what to remind', 'when (optional)'],
  },
  'SLACK-DIGEST': {
    type: 'assistant',
    blurb: 'Summarizes overnight Slack DMs, mentions, and notable channel threads.',
    inputs: [],
  },
  'INBOX-TRIAGE': {
    type: 'assistant',
    blurb: 'Sorts unread Gmail into Urgent, Needs-Response, FYI, and Ignorable.',
    inputs: [],
  },
  'ROTATION-CHECK': {
    type: 'assistant',
    blurb: 'Surfaces secrets rotations due in the next 7 days or already overdue.',
    inputs: [],
  },

  'DIGEST-SALES': {
    type: 'assistant',
    blurb: 'Sales-scoped daily roll-up across Slack, Gmail, Notion, and calendar.',
    inputs: [],
  },
  'DIGEST-MARKETING': {
    type: 'assistant',
    blurb: 'Marketing-scoped daily roll-up across Slack, Gmail, Notion, and calendar.',
    inputs: [],
  },
  'DIGEST-OPS': {
    type: 'assistant',
    blurb: 'Ops-scoped daily roll-up across Slack, Gmail, Notion, and calendar.',
    inputs: [],
  },

  'BRIEF-COMPETITOR': {
    type: 'assistant',
    blurb: 'Cited competitor brief: positioning, pricing, go-to-market, and threat read.',
    inputs: ['competitor name', 'focus area (optional)'],
  },
  'BRIEF-PROSPECT': {
    type: 'assistant',
    blurb: 'Cited prospect brief: company snapshot, buying signals, key people, and hook.',
    inputs: ['prospect / company name', 'focus area (optional)'],
  },
  'BRIEF-MARKET': {
    type: 'assistant',
    blurb: 'Cited market brief: shape, movers, trends, and the so-what for strategy.',
    inputs: ['market / space name', 'focus area (optional)'],
  },

  'TRIAGE-SLACK': {
    type: 'assistant',
    blurb: 'Sorts recent Slack DMs and mentions into four action buckets.',
    inputs: [],
  },
  'TRIAGE-NOTION': {
    type: 'assistant',
    blurb: 'Sorts recent Notion pages, comments, and assignments into four action buckets.',
    inputs: [],
  },
  'TRIAGE-ALL': {
    type: 'assistant',
    blurb: 'Merges Gmail, Slack, and Notion into one cross-surface triage list.',
    inputs: [],
  },

  'MEETING-PREP': {
    type: 'assistant',
    blurb: 'Builds a prep pack for an upcoming meeting from calendar, mail, Slack, and Notion.',
    inputs: ['meeting name or hint'],
  },
  'MEETING-FOLLOWUP': {
    type: 'assistant',
    blurb: 'Turns raw meeting notes into decisions, action items, and DRAFT follow-ups.',
    inputs: ['meeting name', 'raw notes'],
  },

  'WATCH-DEPS': {
    type: 'assistant',
    blurb: 'Surveys dependency manifests for stale, risky, or bump-worthy packages.',
    inputs: [],
  },
  'WATCH-DEADCODE': {
    type: 'assistant',
    blurb: 'Flags likely-unused exports, orphan files, and unused dependencies.',
    inputs: [],
  },
  'WATCH-COST': {
    type: 'assistant',
    blurb: 'Surfaces spend signals: new charges, upcoming renewals, and overage alerts.',
    inputs: [],
  },

  'DRAFT-OUTREACH': {
    type: 'content',
    blurb: 'Fills a human outreach template with recipient-specific slots — draft only.',
    inputs: ['recipient name', 'company', 'hook / value prop', 'call to action'],
  },
  'DRAFT-FOLLOWUP': {
    type: 'content',
    blurb: 'Fills a follow-up template with context-of-last-touch and next step — draft only.',
    inputs: ['recipient name', 'last-touch context', 'next step'],
  },
  'DRAFT-RELEASE-NOTES': {
    type: 'content',
    blurb: 'Fills release-notes framing slots around a human-authored feature list — draft only.',
    inputs: ['version', 'headline feature', 'ship date'],
  },
  'DRAFT-SOCIAL': {
    type: 'content',
    blurb: 'Fills a social-post template in your voice — draft only, no added hype.',
    inputs: ['topic', 'hook', 'link (optional)'],
  },

  'DECK-INVESTOR-UPDATE': {
    type: 'content',
    blurb: 'Drafts an investor-update deck outline, filling only labelled token slots.',
    inputs: ['period', 'headline metric', 'the ask'],
  },
  'DOC-WEEKLY-REPORT': {
    type: 'content',
    blurb: 'Drafts a structured weekly report from the sources you point it to.',
    inputs: ['sources or input file', 'week of (optional)'],
  },
  'SHEET-PIPELINE-EXPORT': {
    type: 'content',
    blurb: 'Exports a named pipeline source to a clean, structured CSV — read-only.',
    inputs: ['pipeline source (Notion db or input file)'],
  },
};

/**
 * Derived from TEMPLATE_CATALOG so existing consumers + tests are unchanged.
 * The catalog is the source of truth; this map is a projection of `type`.
 */
export const TEMPLATE_TYPES: Record<string, TemplateTaskType> = Object.fromEntries(
  Object.entries(TEMPLATE_CATALOG).map(([id, entry]) => [id, entry.type]),
) as Record<string, TemplateTaskType>;

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
