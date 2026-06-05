import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(store.state.healthy ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text(store.systemName).font(.headline)
                Spacer()
                Text("tick \(store.state.lastTick)").font(.caption).foregroundStyle(.secondary)
            }

            Divider()

            if store.state.gates.isEmpty {
                Text("No gates waiting").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("\(store.state.gates.count) gate\(store.state.gates.count == 1 ? "" : "s") waiting")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(store.state.gates.prefix(4)) { g in
                    HStack {
                        Text(g.gate == "preview" ? "◧" : "◨")
                        Text(g.id).font(.callout).lineLimit(1)
                        Spacer()
                        Button(g.gate == "preview" ? "Approve" : "Proceed") {
                            store.decide(g.id, g.gate == "preview" ? "go" : "proceed", note: nil)
                        }
                        .controlSize(.small)
                    }
                }
            }

            Divider()

            HStack {
                Button("Open \(store.systemName)") { openWindow(id: "main") }
                Spacer()
                Button("Tick now") { store.runTick(); store.refresh() }
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .controlSize(.small)
        }
        .padding(12)
        .frame(width: 320)
        .onAppear { store.start() }
    }
}
