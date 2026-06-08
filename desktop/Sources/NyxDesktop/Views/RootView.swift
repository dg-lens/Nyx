import SwiftUI
import AppKit

struct RootView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        VStack(spacing: 0) {
            if store.updateAvailable {
                updateBanner
            }
            TabView {
                GatesView()
                    .tabItem { Label("Gates", systemImage: "checkmark.seal") }
                DispatchView()
                    .tabItem { Label("Dispatch", systemImage: "paperplane") }
                MonitorView()
                    .tabItem { Label("Monitor", systemImage: "waveform.path.ecg") }
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
            }
        }
        .padding(12)
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
            ToolbarItem {
                Button { store.runTick() } label: {
                    if store.ticking {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Tick", systemImage: "bolt.fill")
                    }
                }
                .disabled(store.ticking)
                .help("Run one dispatch tick now")
            }
            ToolbarItem {
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .help("Reload state")
            }
        }
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
        .padding(.bottom, 8)
    }
}
