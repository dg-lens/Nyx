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
    // template symbol. The decoded logo is cached and only re-read from disk when
    // the file path or its modification time changes, so body re-evaluation (every
    // state change / refresh) does not repeat synchronous disk IO + decode.
    private static var cachedLogo: (path: String, mtime: Date, image: NSImage)?

    private static func menuBarIcon(gates: Int) -> NSImage {
        if let url = Layout.effectiveLogoURL {
            let path = url.path
            let mtime = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate]) as? Date
            if let cache = cachedLogo, cache.path == path, cache.mtime == mtime {
                return cache.image
            }
            if let logo = NSImage(contentsOf: url) {
                logo.size = NSSize(width: 18, height: 18)
                cachedLogo = (path, mtime ?? .distantPast, logo)
                return logo
            }
        }
        let symbol = gates > 0 ? "circle.hexagongrid.fill" : "circle.hexagongrid"
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Nyx menu bar") ?? NSImage()
        img.isTemplate = true
        return img
    }
}
