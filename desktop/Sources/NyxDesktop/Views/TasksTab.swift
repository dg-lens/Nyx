import SwiftUI

// Tasks tab content router. Add a page: append a SidebarPage to `pages` and a
// matching case to the switch — no other file changes.
//
// Pages:
//   • Schedule — the n8n-style TasksWorkspace: a week calendar of scheduled
//     tasks (left 4/5), the standing-task list (right 1/5), and a + button
//     that opens the add-flow overlay.
//   • Manage Templates — the personal template library: folders, per-template
//     actions, and promote-a-recent-task.
//   • Create Templates — build a template manually or draft one with Claude.
//
// TemplatesStore is owned HERE (one instance for the whole tab) so the
// add-flow overlay, Manage, and Create pages all see the same library and a
// mutation on one page is immediately visible on the others.
struct TasksTab: View {
    @EnvironmentObject var store: Store
    @StateObject private var templates = TemplatesStore()

    private let pages: [SidebarPage] = [
        SidebarPage("schedule", "Schedule", icon: "calendar"),
        SidebarPage("manage-templates", "Manage Templates", icon: "folder"),
        SidebarPage("create-templates", "Create Templates", icon: "square.and.pencil"),
    ]

    var body: some View {
        TabShellView(pages: pages) { page in
            switch page.id {
            case "schedule":
                TasksWorkspace()
            case "manage-templates":
                ManageTemplatesView()
            case "create-templates":
                CreateTemplatesView()
            default:
                PlaceholderPage(
                    icon: "tray.full",
                    title: page.title,
                    message: "Coming soon.")
            }
        }
        .environmentObject(templates)
    }
}
