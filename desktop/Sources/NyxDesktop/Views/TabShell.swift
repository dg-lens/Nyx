import SwiftUI

// One labelled entry in a tab's vertical left sidebar. `id` is the stable
// selection key; `title` is the shown label; `icon` is an SF Symbol.
struct SidebarPage: Identifiable, Hashable {
    let id: String
    let title: String
    let icon: String

    init(_ id: String, _ title: String, icon: String = "circle") {
        self.id = id
        self.title = title
        self.icon = icon
    }
}

// The four top-level tabs. RootView's top toolbar drives this; each tab's
// content router (DashboardsTab / TasksTab / MonitorTab / AppsTab) reads the
// selected SidebarPage and renders the matching page.
enum ShellTab: String, CaseIterable, Identifiable {
    case dashboards, tasks, monitor, apps

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboards: return "Dashboards"
        case .tasks:      return "Tasks"
        case .monitor:    return "Monitor"
        case .apps:       return "Apps"
        }
    }

    var icon: String {
        switch self {
        case .dashboards: return "rectangle.3.group"
        case .tasks:      return "checklist"
        case .monitor:    return "waveform.path.ecg"
        case .apps:       return "shippingbox"
        }
    }
}

// Reusable per-tab container: a vertical left sidebar of labelled pages plus a
// content region routed by the selected page. The Dashboards and Tasks agents
// add pages by appending to `pages` and extending their tab's content switch —
// no edit to this file. Selection state is owned here and seeded to the first
// page on appear.
struct TabShellView<Content: View>: View {
    let pages: [SidebarPage]
    @ViewBuilder let content: (SidebarPage) -> Content

    @State private var selection: String = ""

    private var selectedPage: SidebarPage? {
        pages.first { $0.id == selection } ?? pages.first
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            sidebar
            Divider()
            Group {
                if let page = selectedPage {
                    content(page)
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .onAppear {
            if selection.isEmpty, let first = pages.first { selection = first.id }
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(pages) { page in
                sidebarRow(page)
            }
            Spacer()
        }
        .frame(width: 168, alignment: .topLeading)
    }

    @ViewBuilder
    private func sidebarRow(_ page: SidebarPage) -> some View {
        let active = (selectedPage?.id == page.id)
        Button {
            selection = page.id
        } label: {
            HStack(spacing: 8) {
                Image(systemName: page.icon)
                    .frame(width: 16)
                    .foregroundStyle(active ? .primary : .secondary)
                Text(page.title)
                    .font(.callout)
                    .foregroundStyle(active ? .primary : .secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                active ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

// Shared placeholder for a tab page whose feature lands in a later stage. Keeps
// the empty-state visual language consistent with GatesView's empty card.
struct PlaceholderPage: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline).foregroundStyle(.secondary)
            Text(message)
                .font(.caption).foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .padding(.top, 40)
    }
}
