import SwiftUI
import AppKit

// Fullscreen ("wall display") presentation mode for the Dashboards tab. The
// manifest-driven Dashboards already subsume a wall display; this just strips the
// shell down to the bare widget grid for kiosk/presentation use. The trigger lives
// in DashboardsTab's left sidebar (a "Present" button) + a ⌘⏎ keyboard shortcut;
// RootView hides its tab bar, top toolbar, and window chrome while `presenting` is
// on. Esc exits back to the normal tab.
//
// The grid itself is DashboardCanvas with `customizing` pinned off — same widget
// tiles, same edge-to-edge GridGeometry, same Store-cadence status refresh (the
// canvas reads store.statusPayloads, which DashboardsTab keeps warm via
// refreshStatusPayloads on the Store subscription — that path is untouched here).
struct DashboardPresentation: View {
    @Binding var layout: DashboardLayout
    let store: DashboardStore
    let state: NyxState
    let onExit: () -> Void

    // Presentation mode never customizes; bind to a constant so the canvas renders
    // read-only (no grid overlay, no drag, no add button).
    @State private var customizing = false

    var body: some View {
        DashboardCanvas(
            layout: $layout,
            store: store,
            state: state,
            customizing: $customizing)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(NSColor.windowBackgroundColor))
        // Esc exits presentation. An invisible default-cancel button captures the
        // key without drawing chrome; the visible exit affordance is the corner hint.
        .overlay(alignment: .topTrailing) { exitHint }
        .background(
            Button("", action: onExit)
                .keyboardShortcut(.cancelAction)
                .hidden())
    }

    // A faint top-right "Esc to exit" hint so the kiosk view isn't a dead end. Kept
    // low-contrast so it doesn't compete with the widgets on a wall display.
    private var exitHint: some View {
        HStack(spacing: 6) {
            Image(systemName: "escape").font(.caption2)
            Text("Esc to exit").font(.caption2)
        }
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.4), in: Capsule())
        .padding(12)
    }
}

// Hides/restores the host NSWindow's titlebar + traffic-light chrome so the grid
// reads edge-to-edge in presentation mode. A zero-size NSView bridge that walks up
// to its window on appear and applies the requested chrome state, restoring the
// originals when `hidden` flips back. This is the only AppKit window touch the
// presentation mode needs — SwiftUI has no native titlebar-hide on macOS 13.
struct WindowChromeHider: NSViewRepresentable {
    let hidden: Bool

    func makeNSView(context: Context) -> NSView {
        let v = ChromeView()
        v.applyDeferred(hidden: hidden)
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? ChromeView)?.applyDeferred(hidden: hidden)
    }

    // NSView that captures its window's original chrome on first sight and toggles
    // it. Applies on the next runloop turn because the view's `window` is nil until
    // it's in the hierarchy.
    final class ChromeView: NSView {
        private var savedTitleVisibility: NSWindow.TitleVisibility?
        private var savedTitlebarTransparent: Bool?
        private var savedStyleMask: NSWindow.StyleMask?

        func applyDeferred(hidden: Bool) {
            DispatchQueue.main.async { [weak self] in self?.apply(hidden: hidden) }
        }

        private func apply(hidden: Bool) {
            guard let win = window else { return }
            if savedStyleMask == nil {
                savedTitleVisibility = win.titleVisibility
                savedTitlebarTransparent = win.titlebarAppearsTransparent
                savedStyleMask = win.styleMask
            }
            if hidden {
                win.titleVisibility = .hidden
                win.titlebarAppearsTransparent = true
                win.styleMask.insert(.fullSizeContentView)
                win.standardWindowButton(.closeButton)?.isHidden = true
                win.standardWindowButton(.miniaturizeButton)?.isHidden = true
                win.standardWindowButton(.zoomButton)?.isHidden = true
            } else {
                if let v = savedTitleVisibility { win.titleVisibility = v }
                if let t = savedTitlebarTransparent { win.titlebarAppearsTransparent = t }
                if let m = savedStyleMask { win.styleMask = m }
                win.standardWindowButton(.closeButton)?.isHidden = false
                win.standardWindowButton(.miniaturizeButton)?.isHidden = false
                win.standardWindowButton(.zoomButton)?.isHidden = false
            }
        }
    }
}
