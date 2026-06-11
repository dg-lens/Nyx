import SwiftUI

// Dashboards tab content router. Add a page: append a SidebarPage to `pages`
// and a matching case to the switch — no other file changes.
struct DashboardsTab: View {
    @EnvironmentObject var store: Store

    private let pages: [SidebarPage] = [
        SidebarPage("main", "Main", icon: "square.grid.2x2"),
    ]

    var body: some View {
        TabShellView(pages: pages) { page in
            switch page.id {
            case "main":
                PlaceholderPage(
                    icon: "square.grid.2x2",
                    title: "Dashboards",
                    message: "The dashboards feature lands next.")
            default:
                PlaceholderPage(
                    icon: "square.grid.2x2",
                    title: page.title,
                    message: "Coming soon.")
            }
        }
    }
}
