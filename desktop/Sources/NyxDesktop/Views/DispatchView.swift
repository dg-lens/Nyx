import SwiftUI

// Template families: the task type each applies to, a one-line blurb shown on
// hover, and the variable inputs the description must supply (used to build the
// fill-in skeleton). MIRROR of the single source of truth at
// apps/assistant/src/index.ts (TEMPLATE_CATALOG) — keep ids/types/blurbs/inputs
// in lockstep with that catalog; the dispatcher validates the emitted
// [template:] tag against it. Order here is the picker's display order.
// code/analysis/pipeline have no templates, so they appear under no type and
// the picker shows Auto only.
private struct TemplateEntry {
    let type: String
    let blurb: String
    let inputs: [String]
}

private enum TemplateCatalog {
    // Display order per type. Keys index into `entries`.
    static let assistant: [String] = [
        "MORNING-BRIEF", "CALENDAR-SYNC", "REMINDER", "SLACK-DIGEST",
        "INBOX-TRIAGE", "ROTATION-CHECK",
        "DIGEST-SALES", "DIGEST-MARKETING", "DIGEST-OPS",
        "BRIEF-COMPETITOR", "BRIEF-PROSPECT", "BRIEF-MARKET",
        "TRIAGE-SLACK", "TRIAGE-NOTION", "TRIAGE-ALL",
        "MEETING-PREP", "MEETING-FOLLOWUP",
        "WATCH-DEPS", "WATCH-DEADCODE", "WATCH-COST",
    ]
    static let content: [String] = [
        "DRAFT-OUTREACH", "DRAFT-FOLLOWUP", "DRAFT-RELEASE-NOTES", "DRAFT-SOCIAL",
        "DECK-INVESTOR-UPDATE", "DOC-WEEKLY-REPORT", "SHEET-PIPELINE-EXPORT",
    ]

    static let entries: [String: TemplateEntry] = [
        "MORNING-BRIEF": TemplateEntry(
            type: "assistant",
            blurb: "Daily roll-up of calendar, Slack, inbox, and Nyx queue status.",
            inputs: []),
        "CALENDAR-SYNC": TemplateEntry(
            type: "assistant",
            blurb: "Flags calendar conflicts, prep-needed meetings, tight gaps, and open focus blocks.",
            inputs: []),
        "REMINDER": TemplateEntry(
            type: "assistant",
            blurb: "Restates a reminder with any related context and DMs it to you.",
            inputs: ["what to remind", "when (optional)"]),
        "SLACK-DIGEST": TemplateEntry(
            type: "assistant",
            blurb: "Summarizes overnight Slack DMs, mentions, and notable channel threads.",
            inputs: []),
        "INBOX-TRIAGE": TemplateEntry(
            type: "assistant",
            blurb: "Sorts unread Gmail into Urgent, Needs-Response, FYI, and Ignorable.",
            inputs: []),
        "ROTATION-CHECK": TemplateEntry(
            type: "assistant",
            blurb: "Surfaces secrets rotations due in the next 7 days or already overdue.",
            inputs: []),

        "DIGEST-SALES": TemplateEntry(
            type: "assistant",
            blurb: "Sales-scoped daily roll-up across Slack, Gmail, Notion, and calendar.",
            inputs: []),
        "DIGEST-MARKETING": TemplateEntry(
            type: "assistant",
            blurb: "Marketing-scoped daily roll-up across Slack, Gmail, Notion, and calendar.",
            inputs: []),
        "DIGEST-OPS": TemplateEntry(
            type: "assistant",
            blurb: "Ops-scoped daily roll-up across Slack, Gmail, Notion, and calendar.",
            inputs: []),

        "BRIEF-COMPETITOR": TemplateEntry(
            type: "assistant",
            blurb: "Cited competitor brief: positioning, pricing, go-to-market, and threat read.",
            inputs: ["competitor name", "focus area (optional)"]),
        "BRIEF-PROSPECT": TemplateEntry(
            type: "assistant",
            blurb: "Cited prospect brief: company snapshot, buying signals, key people, and hook.",
            inputs: ["prospect / company name", "focus area (optional)"]),
        "BRIEF-MARKET": TemplateEntry(
            type: "assistant",
            blurb: "Cited market brief: shape, movers, trends, and the so-what for strategy.",
            inputs: ["market / space name", "focus area (optional)"]),

        "TRIAGE-SLACK": TemplateEntry(
            type: "assistant",
            blurb: "Sorts recent Slack DMs and mentions into four action buckets.",
            inputs: []),
        "TRIAGE-NOTION": TemplateEntry(
            type: "assistant",
            blurb: "Sorts recent Notion pages, comments, and assignments into four action buckets.",
            inputs: []),
        "TRIAGE-ALL": TemplateEntry(
            type: "assistant",
            blurb: "Merges Gmail, Slack, and Notion into one cross-surface triage list.",
            inputs: []),

        "MEETING-PREP": TemplateEntry(
            type: "assistant",
            blurb: "Builds a prep pack for an upcoming meeting from calendar, mail, Slack, and Notion.",
            inputs: ["meeting name or hint"]),
        "MEETING-FOLLOWUP": TemplateEntry(
            type: "assistant",
            blurb: "Turns raw meeting notes into decisions, action items, and DRAFT follow-ups.",
            inputs: ["meeting name", "raw notes"]),

        "WATCH-DEPS": TemplateEntry(
            type: "assistant",
            blurb: "Surveys dependency manifests for stale, risky, or bump-worthy packages.",
            inputs: []),
        "WATCH-DEADCODE": TemplateEntry(
            type: "assistant",
            blurb: "Flags likely-unused exports, orphan files, and unused dependencies.",
            inputs: []),
        "WATCH-COST": TemplateEntry(
            type: "assistant",
            blurb: "Surfaces spend signals: new charges, upcoming renewals, and overage alerts.",
            inputs: []),

        "DRAFT-OUTREACH": TemplateEntry(
            type: "content",
            blurb: "Fills a human outreach template with recipient-specific slots — draft only.",
            inputs: ["recipient name", "company", "hook / value prop", "call to action"]),
        "DRAFT-FOLLOWUP": TemplateEntry(
            type: "content",
            blurb: "Fills a follow-up template with context-of-last-touch and next step — draft only.",
            inputs: ["recipient name", "last-touch context", "next step"]),
        "DRAFT-RELEASE-NOTES": TemplateEntry(
            type: "content",
            blurb: "Fills release-notes framing slots around a human-authored feature list — draft only.",
            inputs: ["version", "headline feature", "ship date"]),
        "DRAFT-SOCIAL": TemplateEntry(
            type: "content",
            blurb: "Fills a social-post template in your voice — draft only, no added hype.",
            inputs: ["topic", "hook", "link (optional)"]),

        "DECK-INVESTOR-UPDATE": TemplateEntry(
            type: "content",
            blurb: "Drafts an investor-update deck outline, filling only labelled token slots.",
            inputs: ["period", "headline metric", "the ask"]),
        "DOC-WEEKLY-REPORT": TemplateEntry(
            type: "content",
            blurb: "Drafts a structured weekly report from the sources you point it to.",
            inputs: ["sources or input file", "week of (optional)"]),
        "SHEET-PIPELINE-EXPORT": TemplateEntry(
            type: "content",
            blurb: "Exports a named pipeline source to a clean, structured CSV — read-only.",
            inputs: ["pipeline source (Notion db or input file)"]),
    ]

    /// Family ids applicable to a task type; empty => the type has no templates.
    static func ids(for type: String) -> [String] {
        switch type {
        case "assistant": return assistant
        case "content": return content
        default: return []
        }
    }

    static func blurb(_ id: String) -> String { entries[id]?.blurb ?? "" }
    static func inputs(_ id: String) -> [String] { entries[id]?.inputs ?? [] }

    /// "BRIEF-COMPETITOR" -> "Brief — Competitor". First hyphen becomes the em
    /// dash separator; remaining segments are title-cased and space-joined.
    static func humanize(_ id: String) -> String {
        let parts = id.split(separator: "-").map { seg -> String in
            let s = seg.lowercased()
            return s.prefix(1).uppercased() + s.dropFirst()
        }
        guard let head = parts.first else { return id }
        let tail = parts.dropFirst().joined(separator: " ")
        return tail.isEmpty ? head : "\(head) — \(tail)"
    }

    /// The fill-in skeleton inserted into an empty editor on template select:
    /// one "Label: " line per input. Empty for zero-input templates.
    static func skeleton(_ id: String) -> String {
        let lines = inputs(id).map { "\($0): " }
        return lines.joined(separator: "\n")
    }
}

// Initial field values for DispatchView when a host opens it pre-filled (the
// add-flow's "Edit first" / "Use template" terminals). Plain strings mirroring
// Store.dispatch's params; `schedule` uses the emitted string forms ("",
// "slot:N", "every:K") and is mapped back onto the schedule controls at init.
struct DispatchPrefill: Hashable {
    var text = ""
    var type = "code"
    var model = "auto"
    var priority = "normal"
    var repo = ""
    var schedule = ""
}

struct DispatchView: View {
    // Optional hook fired AFTER a successful submit (store.dispatch + field reset).
    // Lets a host (the create overlay) animate its dismissal around submit WITHOUT
    // changing what submit does. Defaults to no-op so standalone use is unaffected.
    let onSubmitted: () -> Void
    // True when the host fixes the type (the workflow editor presets+locks
    // "pipeline"); the Type picker renders disabled so the preset can't drift.
    private let typeLocked: Bool
    @EnvironmentObject var store: Store
    @State private var text = ""
    @State private var type = "code"
    @State private var model = "auto"
    @State private var template = "auto"
    // The last fill-in skeleton this view inserted into the editor. Used to tell
    // an unedited skeleton (safe to swap/remove on template change) from text the
    // user actually typed (never touched). Empty when no skeleton is in place.
    @State private var lastSkeleton = ""
    @State private var priority = "normal"
    @State private var repo = ""
    @State private var schedule = "standing"
    @State private var atTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var recurEvery = "6h"

    private let types = ["code", "analysis", "assistant", "content", "pipeline"]
    private let priorities = ["high", "normal", "low"]

    // Prefill maps onto @State initial values only — after init the view owns
    // its fields exactly as before, so standalone use (no prefill) is unchanged.
    init(onSubmitted: @escaping () -> Void = {}, prefill: DispatchPrefill? = nil, lockType: Bool = false) {
        self.onSubmitted = onSubmitted
        self.typeLocked = lockType
        guard let p = prefill else { return }
        _text = State(initialValue: p.text)
        _type = State(initialValue: types.contains(p.type) ? p.type : "code")
        _model = State(initialValue: p.model)
        _priority = State(initialValue: priorities.contains(p.priority) ? p.priority : "normal")
        _repo = State(initialValue: p.repo)
        if p.schedule.hasPrefix("slot:"), let slot = Int(p.schedule.dropFirst(5)),
           slot >= 0, slot < Schedule.slotsPerDay {
            _schedule = State(initialValue: "atTime")
            let hm = Schedule.hourMinute(slot)
            _atTime = State(initialValue: Calendar.current.date(
                bySettingHour: hm.hour, minute: hm.minute, second: 0, of: Date()) ?? Date())
        } else if p.schedule.hasPrefix("every:") {
            let k = String(p.schedule.dropFirst(6))
            _schedule = State(initialValue: "recurring")
            _recurEvery = State(initialValue: ["3h", "6h", "12h", "24h", "7d"].contains(k) ? k : "6h")
        }
    }

    private var templateIds: [String] { TemplateCatalog.ids(for: type) }
    private var typeHasTemplates: Bool { !templateIds.isEmpty }

    /// One-line hint under the picker row for the selected template: the catalog
    /// blurb plus the inputs the description should supply. Only read when a
    /// non-Auto template is selected.
    private var templateHint: String {
        let blurb = TemplateCatalog.blurb(template)
        let inputs = TemplateCatalog.inputs(template)
        guard !inputs.isEmpty else { return blurb }
        return "\(blurb)  Needs: \(inputs.joined(separator: ", "))"
    }

    /// Apply a template selection and reconcile the editor's skeleton.
    /// Templates are SERVER-side prompt builders: the editor text becomes the
    /// description embedded into the template at spawn, so we NEVER insert the
    /// full prompt — only a minimal "Label: " fill-in skeleton from the catalog
    /// inputs, and only when the editor is empty or holds an unedited skeleton we
    /// inserted earlier. Anything the user typed is left untouched.
    private func selectTemplate(_ id: String) {
        let editorIsEmptyOrUneditedSkeleton =
            text.isEmpty || (!lastSkeleton.isEmpty && text == lastSkeleton)

        template = id

        guard editorIsEmptyOrUneditedSkeleton else { return }

        let newSkeleton = id == "auto" ? "" : TemplateCatalog.skeleton(id)
        text = newSkeleton
        lastSkeleton = newSkeleton
    }

    private var scheduleString: String {
        switch schedule {
        case "atTime":
            let c = Calendar.current.dateComponents([.hour, .minute], from: atTime)
            let slot = (c.hour ?? 0) * 12 + (c.minute ?? 0) / 5
            return "slot:\(slot)"
        case "recurring":
            return "every:\(recurEvery)"
        default:
            return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Describe work in plain language. A sonnet pass breaks it into one or more fully-tagged tasks — you don't write the task syntax.")
                .font(.caption).foregroundStyle(.secondary)

            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 110)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Type") {
                    Picker("", selection: $type) { ForEach(types, id: \.self) { Text($0) } }
                        .labelsHidden().fixedSize()
                        .disabled(typeLocked)
                        .onChange(of: type) { _ in
                            // Switching to a type that doesn't offer the current
                            // selection resets it to Auto, so a stale [template:]
                            // never rides along with a mismatched type. Route the
                            // reset through selectTemplate so an unedited skeleton
                            // from the old template is removed (typed text is kept).
                            if !templateIds.contains(template) { selectTemplate("auto") }
                        }
                }
                // Menu-based dropdown (not a Picker): SwiftUI Picker menu items do
                // NOT render .help tooltips on macOS, so each option is a Button
                // carrying .help(blurb) instead. The Menu's default macOS chrome is
                // a bordered pop-up button with a chevron, matching the sibling
                // Pickers' height/font/feel. Binding + "auto" sentinel are unchanged.
                // .help attaches to the enclosing labeled() container, not the Menu:
                // when disabled, macOS does not fire hover/tooltips on the control
                // itself, so the "no templates" hint must live on the wrapper.
                labeled("Template") {
                    Menu {
                        Button("Auto") { selectTemplate("auto") }
                        ForEach(templateIds, id: \.self) { id in
                            Button(TemplateCatalog.humanize(id)) { selectTemplate(id) }
                                .help(TemplateCatalog.blurb(id))
                        }
                    } label: {
                        Text(template == "auto" ? "Auto" : TemplateCatalog.humanize(template))
                    }
                    .fixedSize()
                    .disabled(!typeHasTemplates)
                }
                .help(typeHasTemplates ? "" : "No templates for this type yet")
                labeled("Model") {
                    Picker("", selection: $model) {
                        Text("Auto-Detect").tag("auto")
                        Text("haiku").tag("haiku")
                        Text("sonnet").tag("sonnet")
                        Text("opus").tag("opus")
                    }
                    .labelsHidden().fixedSize()
                }
                labeled("Priority") {
                    Picker("", selection: $priority) { ForEach(priorities, id: \.self) { Text($0) } }
                        .labelsHidden().fixedSize()
                }
                Spacer()
            }

            // Visible hint for the selected template: blurb + the inputs the
            // description should supply. Only shown for a non-Auto selection.
            if template != "auto" {
                Text(templateHint)
                    .font(.caption2).foregroundStyle(.secondary)
            }

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Schedule") {
                    Picker("", selection: $schedule) {
                        Text("Standing").tag("standing")
                        Text("Daily at time").tag("atTime")
                        Text("Recurring").tag("recurring")
                    }.labelsHidden().fixedSize()
                }
                if schedule == "atTime" {
                    labeled("Time of day") {
                        DatePicker("", selection: $atTime, displayedComponents: .hourAndMinute)
                            .labelsHidden()
                    }
                } else if schedule == "recurring" {
                    labeled("Every") {
                        Picker("", selection: $recurEvery) {
                            Text("3 hours").tag("3h")
                            Text("6 hours").tag("6h")
                            Text("12 hours").tag("12h")
                            Text("Daily").tag("24h")
                            Text("Weekly").tag("7d")
                        }.labelsHidden().fixedSize()
                    }
                }
                Spacer()
            }

            HStack(alignment: .bottom) {
                labeled("Repo (optional)") {
                    TextField("org/name", text: $repo)
                        .textFieldStyle(.roundedBorder).frame(width: 240)
                }
                Spacer()
                Button {
                    store.dispatch(text: text, type: type, model: model, priority: priority,
                                   repo: repo.isEmpty ? nil : repo, schedule: scheduleString,
                                   template: template)
                    text = ""
                    lastSkeleton = ""
                    onSubmitted()
                } label: {
                    if store.ticking {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Decomposing…") }
                    } else {
                        Label("Decompose & Queue", systemImage: "wand.and.stars")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || store.ticking)
            }

            if !store.lastDispatch.isEmpty {
                Text(store.lastDispatch).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func labeled<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            content()
        }
    }
}
