import SwiftUI

// Tasks tab content router. Add a page: append a SidebarPage to `pages` and a
// matching case to the switch — no other file changes.
//
// The Workspace page is the n8n-style TasksWorkspace: a week calendar of
// scheduled tasks (left 4/5), the standing-task list (right 1/5), and a + button
// that opens the create overlay (which embeds the existing DispatchView).
struct TasksTab: View {
    @EnvironmentObject var store: Store

    private let pages: [SidebarPage] = [
        SidebarPage("workspace", "Workspace", icon: "tray.full"),
    ]

    var body: some View {
        TabShellView(pages: pages) { page in
            switch page.id {
            case "workspace":
                TasksWorkspace()
            default:
                PlaceholderPage(
                    icon: "tray.full",
                    title: page.title,
                    message: "Coming soon.")
            }
        }
    }
}
