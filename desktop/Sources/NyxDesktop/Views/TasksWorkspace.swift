import SwiftUI

// The Tasks workspace — n8n-style. Left 4/5 is a week calendar (24 hour-rows x
// 7 day-columns) where scheduled tasks render as chips; right 1/5 is the
// standing-task list. A blue + button (bottom-right) opens a full-content-area
// overlay hosting the progressive add-flow (AddFlow.swift): task/workflow
// chooser, pick-existing (saved templates / recents) and create-new
// (use-template / fresh editor) branches.
struct TasksWorkspace: View {
    @EnvironmentObject var store: Store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showCreate = false
    // True for the brief settle after a successful submit, so the contracting
    // overlay reads as "queued" rather than just "closed".
    @State private var justSubmitted = false
    // Shared namespace driving the + button ⇄ overlay marquee: the source (the
    // AddButton) and the destination (the overlay container) carry the same
    // matchedGeometryEffect id, so the button geometrically expands into the
    // overlay on open and contracts back on dismiss.
    @Namespace private var marquee

    private var queue: [QueueItem] { store.state.queue }
    private var scheduled: [QueueItem] { queue.filter { !$0.isStanding } }
    private var standing: [QueueItem] { queue.filter { $0.isStanding } }

    private static let marqueeID = "tasks.create.marquee"

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            HStack(alignment: .top, spacing: 12) {
                ScheduleCalendar(tasks: scheduled)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                StandingTasksColumn(tasks: standing)
                    .frame(width: 248)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if !showCreate {
                AddButton(settling: justSubmitted) { open() }
                    .matchedGeometryEffect(id: Self.marqueeID, in: marquee,
                                           properties: .frame, isSource: true)
                    .padding(16)
            }
        }
        // Backdrop scrim + overlay, both fading with the window spring. The scrim
        // sits UNDER the overlay container and dims the workspace; tapping it
        // dismisses (same path as the X / Esc).
        .overlay {
            if showCreate {
                ZStack {
                    Color.black.opacity(reduceMotion ? 0.18 : 0.22)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { dismiss() }
                        .transition(.opacity)

                    CreateOverlay(
                        onDismiss: { dismiss() },
                        onSubmitted: { submitted() })
                        // matchedGeometry owns the geometric morph: the overlay's
                        // frame interpolates from the +'s last frame, so it visually
                        // EXPANDS out of the button (and CONTRACTS back on dismiss).
                        // The transition is opacity-only — layering a scale on top
                        // of the matched-frame morph double-scales and jitters.
                        .matchedGeometryEffect(id: Self.marqueeID, in: marquee,
                                               properties: .frame, isSource: false)
                        .transition(.opacity)
                        .padding(40)
                }
            }
        }
        .nyxAnimation(Motion.window, value: showCreate)
    }

    private func open() {
        justSubmitted = false
        showCreate = true
    }

    private func dismiss() {
        showCreate = false
    }

    // Submit path: DispatchView has already called store.dispatch. We only animate
    // the contract-back here — flash the settle affordance, then close on the same
    // window spring after a brief, non-blocking beat.
    private func submitted() {
        justSubmitted = true
        showCreate = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            justSubmitted = false
        }
    }
}

// ─── Blue rounded-square + (mirrors the Dashboards customize button) ──────────

private struct AddButton: View {
    // When true, the button has just received a queued submission — it briefly
    // shows a checkmark instead of the plus, so the contract-back reads as success.
    var settling: Bool = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Image(systemName: "plus").opacity(settling ? 0 : 1)
                Image(systemName: "checkmark").opacity(settling ? 1 : 0)
            }
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(Color.blue.opacity(hovering ? 1.0 : 0.9),
                        in: RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Add a task or workflow")
        .nyxAnimation(Motion.quick, value: settling)
    }
}

// ─── Full-content-area create overlay ─────────────────────────────────────────

private struct CreateOverlay: View {
    // Called to dismiss with the contract-back marquee (X / Esc / scrim tap).
    var onDismiss: () -> Void = {}
    // Called AFTER a task has been queued (DispatchView submit, or a summary
    // step's one-click Add). Drives the success settle + contract-back. Does NOT
    // change what submit does — purely the dismissal hook.
    var onSubmitted: () -> Void = {}
    @EnvironmentObject var store: Store
    @EnvironmentObject var templates: TemplatesStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // The step stack. Empty = the task/workflow chooser; pushes/pops drive the
    // within-overlay navigation. Step vocabulary lives in AddFlow.swift.
    @State private var path: [AddStep] = []
    // Drives the push direction: forward slides the incoming step in from
    // trailing; back reverses it. Set by `go` / `pop` BEFORE path changes so the
    // transition reads the right edge.
    @State private var goingForward = true

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            // Step body. .id keys the transition to the step so SwiftUI animates
            // the swap (push/pop) rather than diffing in place. The forward push
            // enters from trailing; back pops toward trailing — direction comes
            // from `goingForward`.
            ZStack {
                stepBody
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .id(path.last?.key ?? "__chooser__")
            .transition(MotionTransition.push(from: goingForward ? .trailing : .leading,
                                              reduceMotion: reduceMotion))
            .clipped()
            .nyxAnimation(Motion.nav, value: path)
        }
        .frame(maxWidth: 760, maxHeight: 620)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
        .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
        // Esc steps back (or closes from the chooser).
        .background(EscHandler { back() })
    }

    private var header: some View {
        HStack(spacing: 8) {
            if !path.isEmpty {
                Button { pop() } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)
                .help("Back")
            }
            Text(title).font(.headline)
            Spacer()
            Button { onDismiss() } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .help("Close")
            .keyboardShortcut(.cancelAction)
        }
        .padding(12)
    }

    private var title: String {
        switch path.last {
        case .none:                              return "Add"
        case .kind(let k):                       return k.addTitle
        case .pickExisting:                      return "Pick existing"
        case .createNew:                         return "Create new"
        case .templatePicker(_, true):           return "Use a template"
        case .templatePicker(_, false):          return "Saved templates"
        case .templateSummary(_, let id):        return templates.template(id)?.name ?? "Template"
        case .recents:                           return "Recent tasks"
        case .recentSummary(_, let r):           return r.id
        case .editor(let k, _):                  return k == .task ? "Create a task" : "Create a workflow"
        }
    }

    // Esc handler: step back when inside the flow, else dismiss the overlay.
    private func back() {
        if !path.isEmpty { pop() } else { onDismiss() }
    }

    // Forward push — set direction first so the transition reads the trailing
    // edge, then change the step.
    private func go(_ step: AddStep) {
        goingForward = true
        path.append(step)
    }

    // Back pop — direction reversed so the step slides toward trailing.
    private func pop() {
        goingForward = false
        path.removeLast()
    }

    @ViewBuilder
    private var stepBody: some View {
        switch path.last {
        case .none:
            chooser
        case .kind(let k):
            ChoicePairStep {
                ChoiceCard(
                    icon: "tray.full",
                    title: "Pick existing",
                    subtitle: "Re-issue a saved template or one of your recent \(k.noun == "task" ? "tasks" : "workflows").",
                    tint: k.tint) { go(.pickExisting(k)) }
            } second: {
                ChoiceCard(
                    icon: "square.and.pencil",
                    title: "Create new",
                    subtitle: "Write a new \(k.noun) — from a template or from scratch.",
                    tint: k.tint) { go(.createNew(k)) }
            }
        case .pickExisting(let k):
            ChoicePairStep {
                ChoiceCard(
                    icon: "folder",
                    title: "Saved template",
                    subtitle: "Pick from your personal template library.",
                    tint: k.tint) { go(.templatePicker(k, editFirst: false)) }
            } second: {
                ChoiceCard(
                    icon: "clock.arrow.circlepath",
                    title: "Recent",
                    subtitle: "Re-issue one of the last 10 \(k.noun == "task" ? "tasks" : "workflows").",
                    tint: k.tint) { go(.recents(k)) }
            }
        case .createNew(let k):
            ChoicePairStep {
                ChoiceCard(
                    icon: "doc.on.doc",
                    title: "Use template",
                    subtitle: "Start from a saved template and tweak it before queueing.",
                    tint: k.tint) { go(.templatePicker(k, editFirst: true)) }
            } second: {
                ChoiceCard(
                    icon: "square.and.pencil",
                    title: "Create fresh",
                    subtitle: "Start with an empty editor.",
                    tint: k.tint) { go(.editor(k, nil)) }
            }
        case .templatePicker(let k, let editFirst):
            TemplatePickerStep(kind: k) { t in
                if editFirst {
                    go(.editor(k, AddFlowDispatch.prefill(t)))
                } else {
                    go(.templateSummary(k, templateId: t.id))
                }
            }
        case .templateSummary(let k, let id):
            if let t = templates.template(id) {
                AddSummaryStep(
                    kind: k, name: t.name,
                    type: t.kind == "workflow" ? "pipeline" : t.type,
                    model: t.model, priority: t.priority,
                    schedule: t.schedule, repo: t.repo, text: t.text,
                    onAdd: {
                        // Honest result: the success settle + dismissal only
                        // fire when the enqueue actually landed; false keeps
                        // the summary open showing its inline error.
                        let ok = AddFlowDispatch.issue(t, via: store)
                        if ok { onSubmitted() }
                        return ok
                    },
                    onEdit: { go(.editor(k, AddFlowDispatch.prefill(t))) })
            } else {
                PlaceholderPage(icon: "folder", title: "Template removed",
                                message: "This template no longer exists.")
            }
        case .recents(let k):
            RecentsStep(kind: k) { r in
                go(.recentSummary(k, r))
            }
        case .recentSummary(let k, let r):
            AddSummaryStep(
                kind: k, name: r.title.isEmpty ? r.id : r.title,
                type: r.type, model: r.model ?? "auto", priority: r.priority,
                schedule: r.schedule, repo: r.repo, text: r.text,
                onAdd: {
                    let ok = AddFlowDispatch.issue(r, via: store)
                    if ok { onSubmitted() }
                    return ok
                },
                onEdit: { go(.editor(k, AddFlowDispatch.prefill(r))) })
        case .editor(let k, let prefill):
            editor(kind: k, prefill: prefill)
        }
    }

    // The two big choices with an "or" between them. The two icons here are the
    // canonical task/workflow icons app-wide (AddKind.icon) — unchanged from the
    // original chooser.
    private var chooser: some View {
        ChoicePairStep {
            ChoiceCard(
                icon: AddKind.task.icon,
                title: AddKind.task.addTitle,
                subtitle: "Queue a single task — from a saved template, a recent task, or scratch.",
                tint: AddKind.task.tint) { go(.kind(.task)) }
        } second: {
            ChoiceCard(
                icon: AddKind.workflow.icon,
                title: AddKind.workflow.addTitle,
                subtitle: "Queue a multi-step workflow — planned, built, and gated by the pipeline.",
                tint: AddKind.workflow.tint) { go(.kind(.workflow)) }
        }
    }

    // The editor terminal. kind=task is DispatchView exactly as today (plus the
    // optional prefill); kind=workflow is the SAME editor with type preset+locked
    // to "pipeline" — Store.dispatch's type param feeds the decomposer's pipeline
    // branch, which emits one [type: pipeline] task the orchestrator runs
    // end-to-end, so no separate workflow editor is needed.
    private func editor(kind: AddKind, prefill: DispatchPrefill?) -> some View {
        ScrollView {
            // onSubmitted fires AFTER DispatchView calls store.dispatch — it only
            // drives the dismissal animation; the queue action itself is unchanged.
            DispatchView(
                onSubmitted: onSubmitted,
                prefill: prefill ?? (kind == .workflow ? DispatchPrefill(type: "pipeline") : nil),
                lockType: kind == .workflow)
                .padding(16)
        }
    }
}

// Bridges the AppKit Esc key to a SwiftUI closure for the overlay. A bare
// .keyboardShortcut(.cancelAction) covers the X button; this also catches Esc
// when focus sits inside the embedded DispatchView's TextEditor.
private struct EscHandler: NSViewRepresentable {
    let onEsc: () -> Void

    func makeNSView(context: Context) -> NSView {
        let v = KeyView()
        v.onEsc = onEsc
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? KeyView)?.onEsc = onEsc
    }

    final class KeyView: NSView {
        var onEsc: (() -> Void)?
        override var acceptsFirstResponder: Bool { false }
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            if event.keyCode == 53 { onEsc?(); return true }   // 53 = Esc
            return super.performKeyEquivalent(with: event)
        }
    }
}
