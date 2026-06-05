import SwiftUI

@main
struct NyxApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        Window(store.systemName, id: "main") {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 660, minHeight: 480)
                .onAppear { store.start() }
        }
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            MenuBarView()
                .environmentObject(store)
        } label: {
            let n = store.state.gates.count
            Image(systemName: n > 0 ? "circle.hexagongrid.fill" : "circle.hexagongrid")
            if n > 0 { Text("\(n)") }
        }
        .menuBarExtraStyle(.window)
    }
}
