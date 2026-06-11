import SwiftUI

// Geometry for the square-cell grid. Given the available content rect (already
// minus both toolbar areas — the GeometryReader sits inside the tab content), we
// pick a uniform square cell size, derive how many whole columns/rows fit, and
// leave a slight uniform margin on all four sides.
struct GridGeometry {
    let cell: CGFloat
    let cols: Int
    let rows: Int
    let originX: CGFloat
    let originY: CGFloat
    let spacing: CGFloat

    // Target cell edge in points before fitting; the actual cell is grown slightly
    // so columns fill the width edge-to-edge inside the margins.
    static let targetCell: CGFloat = 96
    static let margin: CGFloat = 16
    static let gap: CGFloat = 10

    static func compute(_ size: CGSize) -> GridGeometry {
        let usableW = max(0, size.width - 2 * margin)
        let usableH = max(0, size.height - 2 * margin)

        // How many target-sized cells (plus gaps) fit across.
        let cols = max(1, Int((usableW + gap) / (targetCell + gap)))
        let rows = max(1, Int((usableH + gap) / (targetCell + gap)))

        // Square cell sized to the tighter of the two fits so cells stay square and
        // the grid never overflows the usable area.
        let cellW = (usableW - CGFloat(cols - 1) * gap) / CGFloat(cols)
        let cellH = (usableH - CGFloat(rows - 1) * gap) / CGFloat(rows)
        let cell = max(40, min(cellW, cellH))

        // Re-center: with a square cell the grid's footprint may be smaller than the
        // usable area in one axis; distribute the slack into the margins evenly.
        let gridW = CGFloat(cols) * cell + CGFloat(cols - 1) * gap
        let gridH = CGFloat(rows) * cell + CGFloat(rows - 1) * gap
        let originX = (size.width - gridW) / 2
        let originY = (size.height - gridH) / 2

        return GridGeometry(cell: cell, cols: cols, rows: rows,
                            originX: originX, originY: originY, spacing: gap)
    }

    // Pixel frame for a widget occupying (col,row) spanning (w,h) cells.
    func frame(col: Int, row: Int, w: Int, h: Int) -> CGRect {
        let x = originX + CGFloat(col) * (cell + spacing)
        let y = originY + CGFloat(row) * (cell + spacing)
        let width = CGFloat(w) * cell + CGFloat(w - 1) * spacing
        let height = CGFloat(h) * cell + CGFloat(h - 1) * spacing
        return CGRect(x: x, y: y, width: max(cell, width), height: max(cell, height))
    }

    // The cell (col,row) under a pixel point, clamped into the grid.
    func cellAt(_ point: CGPoint) -> (col: Int, row: Int) {
        let col = Int(((point.x - originX) / (cell + spacing)).rounded(.down))
        let row = Int(((point.y - originY) / (cell + spacing)).rounded(.down))
        return (min(max(0, col), cols - 1), min(max(0, row), rows - 1))
    }
}

// Deterministic iPhone-style reflow over a fixed-column grid.
//
// Algorithm (documented, intentionally simple):
//  - The grid has a fixed column count; rows grow unbounded downward.
//  - placeMoved: the dragged widget is pinned to its requested (col,row), clamped
//    so it fits within the columns. Every OTHER widget is then re-packed in stable
//    order (top-to-bottom, left-to-right by current position) into the first free
//    cell range that doesn't overlap an already-placed widget — exactly like the
//    home-screen "everything shifts to fill the gap" behavior.
//  - firstFree: scan row-major for the first origin where a w×h widget fits with no
//    overlap; used when ADDING a widget.
enum GridReflow {
    // Occupancy mask helper over an unbounded-height grid.
    private struct Mask {
        let cols: Int
        var rowsUsed: [Set<Int>] = []   // rowsUsed[r] = set of occupied columns

        mutating func ensure(_ row: Int) {
            while rowsUsed.count <= row { rowsUsed.append([]) }
        }

        func fits(col: Int, row: Int, w: Int, h: Int) -> Bool {
            guard col >= 0, col + w <= cols, row >= 0 else { return false }
            for r in row..<(row + h) {
                guard r < rowsUsed.count else { continue }
                for c in col..<(col + w) where rowsUsed[r].contains(c) { return false }
            }
            return true
        }

        mutating func occupy(col: Int, row: Int, w: Int, h: Int) {
            for r in row..<(row + h) {
                ensure(r)
                for c in col..<(col + w) { rowsUsed[r].insert(c) }
            }
        }
    }

    // First free origin (row-major) for a w×h widget around existing placements.
    static func firstFree(cols: Int, existing: [WidgetInstance], w: Int, h: Int) -> (col: Int, row: Int) {
        var mask = Mask(cols: cols)
        for e in existing { mask.occupy(col: e.col, row: e.row, w: clampW(e.w, cols), h: max(1, e.h)) }
        var row = 0
        while true {
            for col in 0...(max(0, cols - w)) where mask.fits(col: col, row: row, w: w, h: h) {
                return (col, row)
            }
            row += 1
            if row > 512 { return (0, row) }   // safety bound; never reached in practice
        }
    }

    // Reflow after a drag: the dragged widget claims (toCol,toRow); the rest pack in.
    static func placeMoved(_ widgets: [WidgetInstance], movedId: String,
                           toCol: Int, toRow: Int, cols: Int) -> [WidgetInstance] {
        guard let movedIdx = widgets.firstIndex(where: { $0.instanceId == movedId }) else { return widgets }
        var moved = widgets[movedIdx]
        let mw = clampW(moved.w, cols)
        moved.col = min(max(0, toCol), cols - mw)
        moved.row = max(0, toRow)
        moved.w = mw

        var mask = Mask(cols: cols)
        mask.occupy(col: moved.col, row: moved.row, w: mw, h: max(1, moved.h))

        // Pack the others in stable reading order around the pinned dragged widget.
        let others = widgets.enumerated()
            .filter { $0.offset != movedIdx }
            .map { $0.element }
            .sorted { ($0.row, $0.col) < ($1.row, $1.col) }

        var placed: [WidgetInstance] = [moved]
        for var wgt in others {
            let w = clampW(wgt.w, cols)
            let h = max(1, wgt.h)
            let origin = firstFreeInMask(&mask, cols: cols, w: w, h: h)
            wgt.col = origin.col
            wgt.row = origin.row
            wgt.w = w
            mask.occupy(col: origin.col, row: origin.row, w: w, h: h)
            placed.append(wgt)
        }
        return placed
    }

    private static func firstFreeInMask(_ mask: inout Mask, cols: Int, w: Int, h: Int) -> (col: Int, row: Int) {
        var row = 0
        while true {
            for col in 0...(max(0, cols - w)) where mask.fits(col: col, row: row, w: w, h: h) {
                return (col, row)
            }
            row += 1
            if row > 512 { return (0, row) }
        }
    }

    static func clampW(_ w: Int, _ cols: Int) -> Int { min(max(1, w), cols) }
}
