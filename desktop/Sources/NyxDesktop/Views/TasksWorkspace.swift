import SwiftUI

// The Tasks workspace — n8n-style. Left 4/5 is a week calendar (24 hour-rows x
// 7 day-columns) where scheduled tasks render as chips; right 1/5 is the
// standing-task list. A blue + button (bottom-right) opens a full-content-area
// overlay offering "Create a new task" (the existing DispatchView) or
// "Create a new Workflow" (placeholder for a later stage).
struct TasksWorkspace: View {
    @EnvironmentObject var store: Store
    @State private var showCreate = false

    private var queue: [QueueItem] { store.state.queue }
    private var scheduled: [QueueItem] { queue.filter { !$0.isStanding } }
    private var standing: [QueueItem] { queue.filter { $0.isStanding } }

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
                AddButton { showCreate = true }
                    .padding(16)
            }
        }
        .overlay {
            if showCreate {
                CreateOverlay(isPresented: $showCreate)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: showCreate)
    }
}

// ─── Blue rounded-square + (mirrors the Dashboards customize button) ──────────

private struct AddButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
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
    }
}

// ─── Full-content-area create overlay ─────────────────────────────────────────

private struct CreateOverlay: View {
    @Binding var isPresented: Bool
    // nil = the two-choice menu; "task" = embedded DispatchView; "workflow" =
    // placeholder. The operator expands the workflow branch in a later stage.
    @State private var choice: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                switch choice {
                case "task":     taskBranch
                case "workflow": workflowBranch
                default:         chooser
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
        // Esc closes (or steps back to the chooser from a sub-branch).
        .background(EscHandler { back() })
    }

    private var header: some View {
        HStack(spacing: 8) {
            if choice != nil {
                Button { choice = nil } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)
                .help("Back")
            }
            Text(title).font(.headline)
            Spacer()
            Button { isPresented = false } label: {
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

    private func back() {
        if choice != nil { choice = nil } else { isPresented = false }
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
                    tint: .blue) { choice = "task" }
                Text("or").font(.title3).foregroundStyle(.secondary)
                ChoiceCard(
                    icon: "point.3.connected.trianglepath.dotted",
                    title: "Create a new Workflow",
                    subtitle: "Chain tasks into a multi-step workflow.",
                    tint: .purple) { choice = "workflow" }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }

    private var taskBranch: some View {
        ScrollView {
            DispatchView()
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
