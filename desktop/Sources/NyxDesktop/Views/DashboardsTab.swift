import SwiftUI

// Dashboards tab content router. Unlike the static-page tabs, the Dashboards
// sidebar is data-driven: it lists the operator's dashboards (each with a star to
// set it as the primary/home dashboard — exactly one starred at a time) and an
// "+ Add Dashboard" button beneath the list. The sidebar mirrors TabShellView's
// visual language (.quaternary active row, RoundedRectangle(cornerRadius:10),
// callout/caption fonts) but owns its own selection + dashboard model so it can be
// dynamic. The starred dashboard is the tab's home page on open.
struct DashboardsTab: View {
    @EnvironmentObject var store: Store
    @StateObject private var dash = DashboardStore()

    @State private var selection: String = ""
    @State private var showAddSheet = false
    @State private var customizing = false

    private var selectedId: String {
        if !selection.isEmpty, dash.dashboards.contains(where: { $0.id == selection }) {
            return selection
        }
        // Default to the starred (home) dashboard on open.
        return dash.starred?.id ?? dash.dashboards.first?.id ?? ""
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            sidebar
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .onAppear {
            if selection.isEmpty { selection = dash.starred?.id ?? "" }
            dash.reloadManifests()
        }
        .sheet(isPresented: $showAddSheet) {
            AddDashboardSheet(
                onPick: { layout in
                    dash.addDashboard(layout)
                    selection = layout.id
                    showAddSheet = false
                },
                onCancel: { showAddSheet = false })
        }
    }

    // MARK: content

    @ViewBuilder
    private var content: some View {
        if let idx = dash.dashboards.firstIndex(where: { $0.id == selectedId }) {
            DashboardCanvas(
                layout: Binding(
                    get: { dash.dashboards[idx] },
                    set: { dash.updateDashboard($0) }),
                store: dash,
                state: store.state,
                customizing: $customizing)
            .id(selectedId)
        } else {
            PlaceholderPage(icon: "square.grid.2x2", title: "Dashboards",
                            message: "No dashboard selected.")
        }
    }

    // MARK: sidebar — dashboard list (with star) + add button

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(dash.dashboards) { d in
                sidebarRow(d)
            }
            Spacer()
            customizeButton
            addDashboardButton
        }
        .frame(width: 168, alignment: .topLeading)
        .onChange(of: selectedId) { _ in customizing = false }
    }

    // Customize toggle — the dashboard's left-toolbar control that unlocks widgets
    // for drag/delete/add (iPhone-style management).
    private var customizeButton: some View {
        Button {
            withAnimation { customizing.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: customizing ? "checkmark" : "slider.horizontal.3")
                    .frame(width: 16)
                Text(customizing ? "Done" : "Customize").font(.callout)
                Spacer(minLength: 0)
            }
            .foregroundStyle(customizing ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                customizing ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func sidebarRow(_ d: DashboardLayout) -> some View {
        let active = (selectedId == d.id)
        let starred = (dash.starredId == d.id)
        HStack(spacing: 6) {
            Button {
                selection = d.id
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: d.icon)
                        .frame(width: 16)
                        .foregroundStyle(active ? .primary : .secondary)
                    Text(d.name)
                        .font(.callout)
                        .foregroundStyle(active ? .primary : .secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    active ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                    in: RoundedRectangle(cornerRadius: 10))
                .contentShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)

            Button {
                dash.star(d.id)
            } label: {
                Image(systemName: starred ? "star.fill" : "star")
                    .font(.caption)
                    .foregroundStyle(starred ? AnyShapeStyle(.yellow) : AnyShapeStyle(.tertiary))
            }
            .buttonStyle(.plain)
            .help(starred ? "Primary dashboard" : "Set as primary dashboard")
        }
    }

    private var addDashboardButton: some View {
        Button {
            showAddSheet = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus").frame(width: 16)
                Text("Add Dashboard").font(.callout)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
    }
}
