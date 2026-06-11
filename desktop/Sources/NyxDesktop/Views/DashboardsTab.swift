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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Drives the wall-display presentation mode. Owned by RootView so it can strip
    // its own tab bar + top toolbar while the grid is fullscreen; the trigger and
    // the fullscreen overlay live here because this view owns the selection + store.
    @Binding var presenting: Bool

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
        Group {
            if presenting {
                presentationView
            } else {
                normalView
            }
        }
        .onAppear {
            if selection.isEmpty { selection = dash.starred?.id ?? "" }
            dash.reloadManifests()
            dash.refreshStatusPayloads(store.state)
        }
        // Status payloads refresh on the Store cadence (15s), NOT per render — the 1s
        // countdown timer invalidates this tree every second and resolve does file IO.
        // This subscription lives on the OUTER group so it survives entering/exiting
        // presentation mode: status widgets must keep auto-refreshing on a wall display.
        .onReceive(store.$state) { dash.refreshStatusPayloads($0) }
        .sheet(isPresented: $showAddSheet) {
            AddDashboardSheet(
                onPick: { layout in
                    dash.addDashboard(layout)
                    selection = layout.id
                    showAddSheet = false
                },
                onCancel: { showAddSheet = false })
        }
        // Enter/exit rides the signature window spring; reduce-motion collapses it to
        // a fade via Motion.resolve inside nyxAnimation. The grid is the same view in
        // both states, so it cross-fades rather than rebuilding.
        .nyxAnimation(Motion.window, value: presenting)
    }

    private var normalView: some View {
        HStack(alignment: .top, spacing: 12) {
            sidebar
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    // MARK: presentation (wall display)

    // Fullscreen edge-to-edge grid for the currently-selected dashboard. RootView has
    // already stripped its tab bar + top toolbar; this strips the dashboard sidebar
    // and window chrome and hands the canvas the full content rect.
    @ViewBuilder
    private var presentationView: some View {
        if let idx = dash.dashboards.firstIndex(where: { $0.id == selectedId }) {
            DashboardPresentation(
                layout: Binding(
                    get: { dash.dashboards[idx] },
                    set: { dash.updateDashboard($0) }),
                store: dash,
                state: store.state,
                onExit: exitPresentation)
            .id(selectedId)
        } else {
            // No dashboard to present — bail straight back to the normal tab rather
            // than show an empty kiosk.
            Color.clear.onAppear { exitPresentation() }
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
            presentButton
            customizeButton
            addDashboardButton
        }
        .frame(width: 168, alignment: .topLeading)
        .onChange(of: selectedId) { _ in customizing = false }
    }

    // Enter the wall-display presentation mode for the selected dashboard. Sits just
    // above Customize in the sidebar. ⌘⏎ is the keyboard equivalent (the hidden
    // shortcut button below) so a presenter can trigger it without the mouse.
    private var presentButton: some View {
        Button(action: enterPresentation) {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.inset.filled.on.rectangle")
                    .frame(width: 16)
                Text("Present").font(.callout)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(selectedId.isEmpty)
        .help("Present this dashboard fullscreen (⌘⏎)")
        // Hidden ⌘⏎ shortcut: keyboardShortcut needs a focusable control in the tree,
        // and the sidebar is always present in normal mode, so park it here.
        .background(
            Button("", action: enterPresentation)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(selectedId.isEmpty)
                .hidden())
    }

    // MARK: presentation control

    private func enterPresentation() {
        guard !selectedId.isEmpty else { return }
        customizing = false
        presenting = true
    }

    private func exitPresentation() {
        presenting = false
    }

    // Customize toggle — the dashboard's left-toolbar control that unlocks widgets
    // for drag/delete/add (iPhone-style management).
    private var customizeButton: some View {
        Button {
            withAnimation(Motion.resolve(Motion.quick, reduceMotion: reduceMotion)) {
                customizing.toggle()
            }
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
