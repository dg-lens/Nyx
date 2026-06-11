import SwiftUI

// Monitor tab content router. Single Overview page for now: Gates moved here as
// a new section on the far left, then the existing Queue + Task History panels.
// Add a page: append a SidebarPage to `pages` and a matching case to the switch.
struct MonitorTab: View {
    @EnvironmentObject var store: Store

    private let pages: [SidebarPage] = [
        SidebarPage("overview", "Overview", icon: "waveform.path.ecg"),
    ]

    var body: some View {
        TabShellView(pages: pages) { page in
            switch page.id {
            case "overview":
                overview
            default:
                PlaceholderPage(
                    icon: "waveform.path.ecg",
                    title: page.title,
                    message: "Coming soon.")
            }
        }
    }

    // Far-left Gates section, then the Queue + Task History panels (unchanged).
    private var overview: some View {
        HStack(alignment: .top, spacing: 12) {
            MonitorPanel("Gates") {
                GatesView()
            }
            .frame(maxWidth: 320)
            MonitorPanels()
        }
    }
}
