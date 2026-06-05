import SwiftUI
import AppKit

@main
struct NyxApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        Window(store.systemName, id: "main") {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 660, minHeight: 480)
                .onAppear { store.start(); applyDockIcon() }
        }
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            MenuBarView()
                .environmentObject(store)
        } label: {
            Image(nsImage: Self.menuBarIcon(gates: store.state.gates.count))
            if store.state.gates.count > 0 { Text("\(store.state.gates.count)") }
        }
        .menuBarExtraStyle(.window)
    }

    // Custom logo (Data/logo.png) as the menu-bar icon if set, else the default
    // template symbol. Re-read each render so a logo change shows on next refresh.
    private static func menuBarIcon(gates: Int) -> NSImage {
        if let logo = NSImage(contentsOf: Layout.logoPath) {
            logo.size = NSSize(width: 18, height: 18)
            return logo
        }
        let symbol = gates > 0 ? "circle.hexagongrid.fill" : "circle.hexagongrid"
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Nyx menu bar") ?? NSImage()
        img.isTemplate = true
        return img
    }
}
