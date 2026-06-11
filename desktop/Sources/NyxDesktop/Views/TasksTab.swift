import SwiftUI

// Tasks tab content router. Add a page: append a SidebarPage to `pages` and a
// matching case to the switch — no other file changes.
//
// DispatchView is no longer a top-level tab but stays compiled + reachable for
// later embedding into the workspace. The Workspace page references it behind a
// disclosure so the type is exercised (no dead-code warning) until the Tasks
// agent wires it into the real workspace layout.
struct TasksTab: View {
    @EnvironmentObject var store: Store

    private let pages: [SidebarPage] = [
        SidebarPage("workspace", "Workspace", icon: "tray.full"),
    ]

    var body: some View {
        TabShellView(pages: pages) { page in
            switch page.id {
            case "workspace":
                workspacePage
            default:
                PlaceholderPage(
                    icon: "tray.full",
                    title: page.title,
                    message: "Coming soon.")
            }
        }
    }

    private var workspacePage: some View {
        VStack(alignment: .leading, spacing: 12) {
            PlaceholderPage(
                icon: "tray.full",
                title: "Tasks Workspace",
                message: "The tasks workspace lands next.")
            DisclosureGroup("Dispatch (preview — moving into the workspace)") {
                DispatchView()
                    .padding(.top, 8)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(12)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
