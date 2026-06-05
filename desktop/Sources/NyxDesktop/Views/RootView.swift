import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        TabView {
            GatesView()
                .tabItem { Label("Gates", systemImage: "checkmark.seal") }
            DispatchView()
                .tabItem { Label("Dispatch", systemImage: "paperplane") }
            MonitorView()
                .tabItem { Label("Monitor", systemImage: "waveform.path.ecg") }
        }
        .padding(12)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                HStack(spacing: 6) {
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
}
