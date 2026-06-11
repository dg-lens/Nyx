import SwiftUI

// The + overlay's progressive branching flow. The overlay container + the
// button morph live in TasksWorkspace (matchedGeometry marquee — untouched);
// this file owns the step vocabulary and the step bodies. Steps push/pop with
// the existing motion vocabulary (MotionTransition.push + Motion.nav via
// .nyxAnimation), driven by CreateOverlay's path stack.
//
// Flow shape:
//   chooser (task | workflow)
//     └ kind: Pick existing | Create new
//         ├ pickExisting: Saved template | Recent
//         │    ├ templatePicker → templateSummary → add-to-queue / editor
//         │    └ recents        → recentSummary   → add-to-queue / editor
//         └ createNew: Use template | Create fresh
//              ├ templatePicker (editFirst) → editor (prefilled)
//              └ editor (fresh — DispatchView exactly as today)

// Canonical kind identity. These two icons came from the original create
// overlay's chooser and are THE task/workflow icons app-wide — every page that
// indicates kind (add-flow, Manage/Create Templates) reuses them from here.
enum AddKind: String, Hashable {
    case task, workflow

    var icon: String { self == .task ? "checklist" : "point.3.connected.trianglepath.dotted" }
    var tint: Color { self == .task ? .blue : .purple }
    var noun: String { rawValue }
    var addTitle: String { self == .task ? "Add a task" : "Add a workflow" }
}

// One step inside the overlay. The chooser is the empty path; everything else
// pushes onto CreateOverlay's stack. `key` keys the .id() transition so SwiftUI
// animates the push/pop swap rather than diffing in place.
enum AddStep: Hashable {
    case kind(AddKind)
    case pickExisting(AddKind)
    case createNew(AddKind)
    case templatePicker(AddKind, editFirst: Bool)
    case templateSummary(AddKind, templateId: String)
    case recents(AddKind)
    case recentSummary(AddKind, RecentTask)
    case editor(AddKind, DispatchPrefill?)

    var key: String {
        switch self {
        case .kind(let k):                  return "kind.\(k.rawValue)"
        case .pickExisting(let k):          return "pick.\(k.rawValue)"
        case .createNew(let k):             return "new.\(k.rawValue)"
        case .templatePicker(let k, let e): return "tplpick.\(k.rawValue).\(e)"
        case .templateSummary(_, let id):   return "tplsum.\(id)"
        case .recents(let k):               return "recents.\(k.rawValue)"
        case .recentSummary(_, let r):      return "recsum.\(r.id)"
        case .editor(let k, _):             return "editor.\(k.rawValue)"
        }
    }
}

// ─── Two-choice step layout (chooser + the branch steps) ─────────────────────

struct ChoiceCard: View {
    let icon: String
    let title: String
    let subtitle: String
    let tint: Color
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(tint)
                Text(title).font(.title3.weight(.semibold))
                Text(subtitle)
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(24)
            .frame(width: 260, height: 200)
            .background(.quaternary.opacity(hovering ? 0.7 : 0.4),
                        in: RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(hovering ? tint.opacity(0.6) : Color.clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

// Two big choices with an "or" between them — the original chooser's layout,
// reused by every binary step.
struct ChoicePairStep<First: View, Second: View>: View {
    @ViewBuilder let first: First
    @ViewBuilder let second: Second

    var body: some View {
        VStack {
            Spacer()
            HStack(spacing: 24) {
                first
                Text("or").font(.title3).foregroundStyle(.secondary)
                second
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }
}

// ─── Saved-template picker ────────────────────────────────────────────────────

// Personal templates grouped by folder as DisclosureGroup sections (the
// AddWidgetPanel/manifestsByPlugin idiom), filtered to the chosen kind.
struct TemplatePickerStep: View {
    @EnvironmentObject var templates: TemplatesStore
    let kind: AddKind
    let onSelect: (TaskTemplate) -> Void

    @State private var expanded: Set<String> = []

    private var groups: [(label: String, key: String, items: [TaskTemplate])] {
        templates.grouped.compactMap { group in
            let items = group.items.filter { $0.kind == kind.rawValue }
            guard !items.isEmpty else { return nil }
            return (group.folder?.name ?? "Ungrouped", group.folder?.id ?? "__ungrouped__", items)
        }
    }

    var body: some View {
        if groups.isEmpty {
            PlaceholderPage(
                icon: "folder",
                title: "No saved \(kind.noun) templates",
                message: "Build templates on the Tasks tab's Create Templates page, then re-issue them here in one click.")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(groups, id: \.key) { group in
                        DisclosureGroup(isExpanded: Binding(
                            get: { expanded.contains(group.key) },
                            set: { if $0 { expanded.insert(group.key) } else { expanded.remove(group.key) } })) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(group.items) { t in
                                    templateRow(t)
                                }
                            }
                            .padding(.top, 4)
                        } label: {
                            Text(group.label).font(.caption.bold()).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(16)
            }
            .onAppear {
                if expanded.isEmpty, let first = groups.first { expanded.insert(first.key) }
            }
        }
    }

    private func templateRow(_ t: TaskTemplate) -> some View {
        Button { onSelect(t) } label: {
            HStack(spacing: 8) {
                Image(systemName: kind.icon)
                    .foregroundStyle(kind.tint).frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.name).font(.callout)
                    Text(t.text).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(t.type).font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(TaskPalette.color(t.type).opacity(0.15), in: Capsule())
                    .foregroundStyle(TaskPalette.color(t.type))
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

// ─── Recents list ─────────────────────────────────────────────────────────────

// The last 10 issued tasks of the chosen kind, newest first, recovered from
// nyx.md by RecentTasks (see that file for why the audit DB can't source this).
// The parse runs in .task — file IO stays off the main actor, never in body.
struct RecentsStep: View {
    let kind: AddKind
    let onSelect: (RecentTask) -> Void

    @State private var recents: [RecentTask]? = nil

    private var shown: [RecentTask] {
        Array((recents ?? []).filter { $0.kind == kind.rawValue }.prefix(10))
    }

    var body: some View {
        Group {
            if recents == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if shown.isEmpty {
                PlaceholderPage(
                    icon: "clock.arrow.circlepath",
                    title: "No recent \(kind.noun)s",
                    message: "Tasks you issue show up here for one-click re-issue.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(shown) { r in
                            recentRow(r)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .task { recents = await RecentTasks.fetch(limit: 50) }
    }

    private func recentRow(_ r: RecentTask) -> some View {
        Button { onSelect(r) } label: {
            HStack(spacing: 8) {
                Image(systemName: r.completed ? "checkmark.circle" : "circle.dashed")
                    .foregroundStyle(.secondary).frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(r.id).font(.callout)
                    Text(r.title).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(r.type).font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(TaskPalette.color(r.type).opacity(0.15), in: Capsule())
                    .foregroundStyle(TaskPalette.color(r.type))
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

// ─── Selection summary (template + recent share it) ──────────────────────────

// What's about to be queued, with the two terminals: "Add to queue" re-issues
// through the same Store.dispatch path DispatchView submits through, "Edit
// first" opens the prefilled editor instead. onAdd returns whether the enqueue
// actually landed — the host fires its success dismissal only on true; false
// keeps the step open and shows the inline error here (the Store.lastDispatch
// error-text idiom), never the success checkmark.
struct AddSummaryStep: View {
    let kind: AddKind
    let name: String
    let type: String
    let model: String
    let priority: String
    let schedule: String?
    let repo: String?
    let text: String
    let onAdd: () -> Bool
    let onEdit: () -> Void

    @State private var addError = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: kind.icon)
                    .font(.title2)
                    .foregroundStyle(kind.tint)
                Text(name).font(.title3.weight(.semibold))
                Spacer()
            }

            HStack(spacing: 6) {
                chip(type, tint: TaskPalette.color(type))
                chip(model)
                chip(priority)
                chip(Self.scheduleLabel(schedule))
                if let repo, !repo.isEmpty { chip(repo) }
                Spacer()
            }

            ScrollView {
                Text(text)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(12)
            }
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))

            HStack {
                if !addError.isEmpty {
                    Text(addError).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { onEdit() } label: {
                    Label("Edit first", systemImage: "pencil")
                }
                Button {
                    addError = onAdd() ? "" : "Failed to enqueue — nothing was queued. Try again, or use Edit first."
                } label: {
                    Label("Add to queue", systemImage: "wand.and.stars")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func chip(_ label: String, tint: Color = .secondary) -> some View {
        Text(label).font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }

    // Human label for a stored schedule string: nil/"" => standing,
    // "slot:N" => daily HH:MM, "every:K" => the standing-list cadence label.
    static func scheduleLabel(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "standing" }
        if raw.hasPrefix("slot:"), let n = Int(raw.dropFirst(5)), n >= 0, n < Schedule.slotsPerDay {
            return "daily \(Schedule.slotToTime(n))"
        }
        if raw.hasPrefix("every:"), let step = Schedule.everyStep(String(raw.dropFirst(6))) {
            return Schedule.everyLabel(stepSlots: step)
        }
        return raw
    }
}

// ─── Shared dispatch glue ─────────────────────────────────────────────────────

enum AddFlowDispatch {
    static let validTypes = ["code", "content", "analysis", "assistant", "pipeline"]

    // The DispatchPrefill for editing a template before queueing. Workflow
    // templates always edit as pipeline — the only type the pipeline
    // orchestrator runs end-to-end.
    static func prefill(_ t: TaskTemplate) -> DispatchPrefill {
        DispatchPrefill(
            text: t.text,
            type: t.kind == "workflow" ? "pipeline" : t.type,
            model: t.model,
            priority: t.priority,
            repo: t.repo ?? "",
            schedule: t.schedule ?? "")
    }

    static func prefill(_ r: RecentTask) -> DispatchPrefill {
        DispatchPrefill(
            text: r.text,
            type: validTypes.contains(r.type) ? r.type : "assistant",
            model: r.model ?? "auto",
            priority: r.priority,
            repo: r.repo ?? "",
            schedule: r.schedule ?? "")
    }

    // One-click re-issue — the same Store.dispatch path DispatchView submits
    // through (enqueue decompose_task + fire a tick). Returns whether the row
    // was actually recorded: empty re-issuable text and a busy DB are both
    // failures the summary step must surface, never report as queued.
    @MainActor
    static func issue(_ t: TaskTemplate, via store: Store) -> Bool {
        guard !t.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return store.dispatch(
            text: t.text,
            type: t.kind == "workflow" ? "pipeline" : t.type,
            model: t.model,
            priority: t.priority,
            repo: t.repo,
            schedule: t.schedule ?? "")
    }

    @MainActor
    static func issue(_ r: RecentTask, via store: Store) -> Bool {
        guard !r.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return store.dispatch(
            text: r.text,
            type: validTypes.contains(r.type) ? r.type : "assistant",
            model: r.model ?? "auto",
            priority: r.priority,
            repo: r.repo,
            schedule: r.schedule ?? "")
    }
}
