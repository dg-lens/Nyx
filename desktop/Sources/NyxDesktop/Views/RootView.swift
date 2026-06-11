import SwiftUI
import AppKit

struct RootView: View {
    @EnvironmentObject var store: Store
    @State private var tab: ShellTab = .dashboards
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            if store.updateAvailable {
                updateBanner
            }
            topBar
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(12)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                HStack(spacing: 6) {
                    if let url = Layout.effectiveLogoURL, let logo = NSImage(contentsOf: url) {
                        Image(nsImage: logo).resizable().scaledToFit().frame(width: 16, height: 16)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    Circle()
                        .fill(store.state.healthy ? Color.green : Color.secondary)
                        .frame(width: 8, height: 8)
                    Text(store.systemName).font(.headline)
                    Text("· next tick \(store.nextTickCountdown)")
                        .foregroundStyle(.secondary).font(.caption).monospacedDigit()
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
    }

    // Custom navigation shell top bar: the 3 tabs on the left, and a right-aligned
    // cluster of [tick][refresh] · gear. Settings is no longer a tab — the gear at
    // the far right opens SettingsView as a sheet.
    private var topBar: some View {
        HStack(spacing: 4) {
            ForEach(ShellTab.allCases) { t in
                tabButton(t)
            }

            Spacer()

            // tick + refresh, shifted left of the divider with a slight margin.
            HStack(spacing: 6) {
                Button { store.runTick() } label: {
                    if store.ticking {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Tick", systemImage: "bolt.fill")
                    }
                }
                .disabled(store.ticking)
                .help("Run one dispatch tick now")

                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .help("Reload state")
            }
            .padding(.trailing, 6)

            Divider().frame(height: 18)

            // Settings gear at the far right.
            Button { showSettings = true } label: { Image(systemName: "gearshape") }
                .help("Settings")
                .padding(.leading, 6)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func tabButton(_ t: ShellTab) -> some View {
        let active = (tab == t)
        Button {
            tab = t
        } label: {
            HStack(spacing: 6) {
                Image(systemName: t.icon)
                Text(t.title).font(.callout)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(active ? .primary : .secondary)
            .background(
                active ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .dashboards: DashboardsTab()
        case .tasks:      TasksTab()
        case .monitor:    MonitorTab()
        }
    }

    private var settingsSheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Settings").font(.headline)
                Spacer()
                Button("Done") { showSettings = false }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
            Divider()
            SettingsView()
                .environmentObject(store)
        }
        .frame(width: 640, height: 560)
    }

    private var updateBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.up.circle.fill").foregroundStyle(.blue)
            Text("Update available — \(store.updateLocal) → \(store.updateRemote)")
                .font(.callout)
            Spacer()
            Button {
                store.applyUpdate()
            } label: {
                if store.updating {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Updating…") }
                } else {
                    Text("Update now")
                }
            }
            .disabled(store.updating)
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.blue.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
