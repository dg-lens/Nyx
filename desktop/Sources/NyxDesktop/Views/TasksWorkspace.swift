import SwiftUI

// The Tasks workspace — n8n-style. Left 4/5 is a week calendar (24 hour-rows x
// 7 day-columns) where scheduled tasks render as chips; right 1/5 is the
// standing-task list. A blue + button (bottom-right) opens a full-content-area
// overlay offering "Create a new task" (the existing DispatchView) or
// "Create a new Workflow" (placeholder for a later stage).
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
        .help("Create a new task or workflow")
        .nyxAnimation(Motion.quick, value: settling)
    }
}

// ─── Full-content-area create overlay ─────────────────────────────────────────

private struct CreateOverlay: View {
    // Called to dismiss with the contract-back marquee (X / Esc / scrim tap).
    var onDismiss: () -> Void = {}
    // Called AFTER DispatchView has queued the task. Drives the success settle +
    // contract-back. Does NOT change what submit does — purely the dismissal hook.
    var onSubmitted: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // nil = the two-choice menu; "task" = embedded DispatchView; "workflow" =
    // placeholder. The operator expands the workflow branch in a later stage.
    @State private var choice: String? = nil
    // Drives the push direction: forward (chooser → branch) slides the incoming
    // step in from trailing; back (branch → chooser) reverses it. Set by `go` /
    // `back` BEFORE choice changes so the transition reads the right edge.
    @State private var goingForward = true

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            // Step body. nil ⇒ chooser; a set value ⇒ the branch. .id keys the
            // transition to the step so SwiftUI animates the swap (push/pop) rather
            // than diffing in place. The forward push enters from trailing; back
            // pops toward trailing — direction comes from `goingForward`.
            ZStack {
                switch choice {
                case "task":     taskBranch
                case "workflow": workflowBranch
                default:         chooser
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .id(choice ?? "__chooser__")
            .transition(MotionTransition.push(from: goingForward ? .trailing : .leading,
                                              reduceMotion: reduceMotion))
            .clipped()
            .nyxAnimation(Motion.nav, value: choice)
        }
        .frame(maxWidth: 760, maxHeight: 620)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
        .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
        // Esc closes (or steps back to the chooser from a sub-branch).
        .background(EscHandler { back() })
    }

    private var header: some View {
        HStack(spacing: 8) {
            if choice != nil {
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
        switch choice {
        case "task":     return "Create a new task"
        case "workflow": return "Create a new Workflow"
        default:         return "Create"
        }
    }

    // Esc handler: step back to the chooser from a branch, else dismiss the overlay.
    private func back() {
        if choice != nil { pop() } else { onDismiss() }
    }

    // Forward push into a branch — set direction first so the transition reads the
    // trailing edge, then change the step.
    private func go(_ branch: String) {
        goingForward = true
        choice = branch
    }

    // Back pop to the chooser — direction reversed so the step slides toward trailing.
    private func pop() {
        goingForward = false
        choice = nil
    }

    // The two big choices with an "or" between them.
    private var chooser: some View {
        VStack {
            Spacer()
            HStack(spacing: 24) {
                ChoiceCard(
                    icon: "checklist",
                    title: "Create a new task",
                    subtitle: "Describe work in plain language; a sonnet pass tags and queues it.",
                    tint: .blue) { go("task") }
                Text("or").font(.title3).foregroundStyle(.secondary)
                ChoiceCard(
                    icon: "point.3.connected.trianglepath.dotted",
                    title: "Create a new Workflow",
                    subtitle: "Chain tasks into a multi-step workflow.",
                    tint: .purple) { go("workflow") }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }

    private var taskBranch: some View {
        ScrollView {
            // onSubmitted fires AFTER DispatchView calls store.dispatch — it only
            // drives the dismissal animation; the queue action itself is unchanged.
            DispatchView(onSubmitted: onSubmitted)
                .padding(16)
        }
    }

    private var workflowBranch: some View {
        PlaceholderPage(
            icon: "point.3.connected.trianglepath.dotted",
            title: "Workflow builder",
            message: "Next stage. Chaining tasks into workflows lands here.")
    }
}

private struct ChoiceCard: View {
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
