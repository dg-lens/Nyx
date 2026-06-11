import SwiftUI

// The grid canvas for one dashboard. Computes the square-cell grid from available
// geometry (GeometryReader = window content minus both toolbar areas, since this
// sits inside the tab content region), lays widgets at their cell rects, and in
// customize mode supports drag-to-reflow + per-widget delete + the blue add button
// + the right-side add-widget panel. The Customize toggle itself lives in the
// dashboard's left sidebar (DashboardsTab), driving the `customizing` binding here.
struct DashboardCanvas: View {
    @Binding var layout: DashboardLayout
    let store: DashboardStore
    let state: NyxState
    @Binding var customizing: Bool

    @State private var showAddPanel = false
    @State private var dragId: String? = nil
    @State private var dragTranslation: CGSize = .zero
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            let grid = GridGeometry.compute(geo.size)
            ZStack(alignment: .topLeading) {
                if customizing { gridBackground(grid) }

                ForEach(layout.widgets) { w in
                    widgetTile(w, grid: grid)
                }

                if customizing {
                    addButton
                        .position(x: geo.size.width - 36, y: geo.size.height - 36)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topTrailing) {
                if customizing && showAddPanel {
                    AddWidgetPanel(store: store, onAdd: addWidget,
                                   onClose: { showAddPanel = false },
                                   gridCols: grid.cols)
                        .frame(width: 240)
                        .frame(maxHeight: .infinity)
                        .transition(MotionTransition.slide(from: .trailing,
                                                           reduceMotion: reduceMotion))
                }
            }
        }
        // The add-panel slides in/out on the window spring (the same feel as the
        // Tasks create overlay); reduce-motion collapses it to a fade.
        .nyxAnimation(Motion.window, value: showAddPanel)
        .onChange(of: customizing) { isOn in
            if !isOn { showAddPanel = false }
        }
    }

    // Faint cell grid shown only in customize mode so drops read predictably.
    private func gridBackground(_ grid: GridGeometry) -> some View {
        Canvas { ctx, _ in
            for r in 0..<grid.rows {
                for c in 0..<grid.cols {
                    let f = grid.frame(col: c, row: r, w: 1, h: 1)
                    ctx.stroke(Path(roundedRect: f, cornerRadius: 8),
                               with: .color(.secondary.opacity(0.12)), lineWidth: 1)
                }
            }
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func widgetTile(_ w: WidgetInstance, grid: GridGeometry) -> some View {
        let base = grid.frame(col: w.col, row: w.row, w: clampW(w.w, grid.cols), h: w.h)
        let isDragging = dragId == w.instanceId
        let offset = isDragging ? dragTranslation : .zero

        WidgetView(
            instance: w,
            manifest: store.manifest(w.manifestId),
            state: state,
            statusPayload: store.statusPayloads[w.manifestId] ?? .preparing,
            actions: store.widgetActions[w.manifestId] ?? [],
            customizing: customizing,
            onDelete: { deleteWidget(w.instanceId) },
            onEditText: { setText(w.instanceId, $0) })
            .frame(width: base.width, height: base.height)
            .position(x: base.midX + offset.width, y: base.midY + offset.height)
            .zIndex(isDragging ? 10 : 0)
            .opacity(isDragging ? 0.85 : 1)
            .gesture(customizing ? dragGesture(w, grid: grid) : nil)
    }

    private func dragGesture(_ w: WidgetInstance, grid: GridGeometry) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                dragId = w.instanceId
                dragTranslation = value.translation
            }
            .onEnded { value in
                let base = grid.frame(col: w.col, row: w.row, w: clampW(w.w, grid.cols), h: w.h)
                let dropCenter = CGPoint(x: base.midX + value.translation.width,
                                         y: base.midY + value.translation.height)
                // Map the dropped top-left corner (not center) to a target cell so
                // wide/tall widgets land where their leading edge points.
                let topLeft = CGPoint(x: dropCenter.x - base.width / 2,
                                      y: dropCenter.y - base.height / 2)
                let target = grid.cellAt(CGPoint(x: topLeft.x + grid.cell / 2,
                                                 y: topLeft.y + grid.cell / 2))
                withAnimation(Motion.resolve(Motion.nav, reduceMotion: reduceMotion)) {
                    layout.widgets = GridReflow.placeMoved(
                        layout.widgets, movedId: w.instanceId,
                        toCol: target.col, toRow: target.row, cols: grid.cols)
                }
                dragId = nil
                dragTranslation = .zero
                store.updateDashboard(layout)
            }
    }

    // Blue rounded-square "+" at bottom-right that opens the add-widget panel.
    // The toggle is a plain state flip; the .nyxAnimation(value: showAddPanel)
    // modifier on the body owns the (reduce-motion-aware) window-spring animation.
    private var addButton: some View {
        Button {
            showAddPanel.toggle()
        } label: {
            Image(systemName: "plus")
                .font(.title2.bold())
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Color.blue, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .shadow(radius: 4, y: 2)
        .help("Add a widget")
    }

    // MARK: mutations

    private func addWidget(_ manifest: WidgetManifest, cols: Int) {
        let origin = GridReflow.firstFree(cols: cols, existing: layout.widgets,
                                          w: manifest.defaultSize.w, h: manifest.defaultSize.h)
        let inst = WidgetInstance(
            instanceId: DashboardTemplates.newInstanceId(),
            manifestId: manifest.id,
            col: origin.col, row: origin.row,
            w: manifest.defaultSize.w, h: manifest.defaultSize.h,
            text: { if case .staticText = manifest.source { return "" } else { return nil } }())
        layout.widgets.append(inst)
        store.updateDashboard(layout)
    }

    private func deleteWidget(_ id: String) {
        layout.widgets.removeAll { $0.instanceId == id }
        store.updateDashboard(layout)
    }

    // Keystroke path: mutate a copy and go through the store's debounced write
    // directly. Mutating the `layout` binding here would fire the binding setter's
    // immediate updateDashboard → save() and defeat the debounce.
    private func setText(_ id: String, _ text: String) {
        guard let idx = layout.widgets.firstIndex(where: { $0.instanceId == id }) else { return }
        var next = layout
        next.widgets[idx].text = text
        store.updateDashboardDebounced(next)
    }

    private func clampW(_ w: Int, _ cols: Int) -> Int { min(max(1, w), cols) }
}
