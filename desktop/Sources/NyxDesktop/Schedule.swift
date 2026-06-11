import Foundation

// Slot math mirrored from apps/dispatcher/src/task-reader.ts — the single source
// of truth the dispatcher uses. The day is 288 five-minute slots; the desktop
// reads the same [slot:]/[every:] tags off nyx.md, so the math must agree
// exactly or the calendar would show fire-times the dispatcher never honors.
enum Schedule {
    static let minutesPerSlot = 5
    static let slotsPerHour = 60 / minutesPerSlot       // 12
    static let slotsPerDay = 24 * slotsPerHour          // 288

    // Wall-clock "HH:MM" for a slot index. slotToTime() in task-reader.ts.
    static func slotToTime(_ slot: Int) -> String {
        let h = slot / slotsPerHour
        let m = (slot % slotsPerHour) * minutesPerSlot
        return String(format: "%02d:%02d", h, m)
    }

    // Hour and minute components of a slot, for placing a chip on the grid.
    static func hourMinute(_ slot: Int) -> (hour: Int, minute: Int) {
        (slot / slotsPerHour, (slot % slotsPerHour) * minutesPerSlot)
    }

    // parseEveryStep(): "5m"/"15m" (positive multiple of 5), "Xh", "Xd" -> step in
    // slots, or nil for malformed input. Caller pre-filters the regex to m|h|d.
    static func everyStep(_ raw: String) -> Int? {
        let s = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard let unit = s.last, "mhd".contains(unit) else { return nil }
        guard let n = Int(s.dropLast().trimmingCharacters(in: .whitespaces)), n > 0 else { return nil }
        switch unit {
        case "m": return n % minutesPerSlot == 0 ? n / minutesPerSlot : nil
        case "h": return n * slotsPerHour
        case "d": return n * slotsPerDay
        default:  return nil
        }
    }

    // The within-day slots a cadence task fires at, given its step. Mirrors the
    // picker's `globalSlot % step === 0`: for sub-day steps the fire-slots are
    // 0, step, 2*step, … < slotsPerDay (the same every day). For multi-day steps
    // (step >= slotsPerDay) it fires once a day at slot 0 (on matching days only —
    // the calendar shows the daily anchor; which calendar day is a separate axis).
    static func cadenceFireSlots(step: Int) -> [Int] {
        guard step > 0 else { return [] }
        if step >= slotsPerDay { return [0] }
        return stride(from: 0, to: slotsPerDay, by: step).map { $0 }
    }

    // Human label for a schedule, used in chip tooltips / the standing list.
    static func everyLabel(stepSlots: Int) -> String {
        if stepSlots % slotsPerDay == 0 {
            let d = stepSlots / slotsPerDay
            return d == 1 ? "daily" : "every \(d)d"
        }
        if stepSlots % slotsPerHour == 0 {
            return "every \(stepSlots / slotsPerHour)h"
        }
        return "every \(stepSlots * minutesPerSlot)m"
    }
}

// Per-type accent color for chips/badges, consistent across the Tasks tab.
import SwiftUI

enum TaskPalette {
    static func color(_ type: String) -> Color {
        switch type.lowercased() {
        case "code":      return .blue
        case "analysis":  return .purple
        case "assistant": return .teal
        case "content":   return .orange
        case "pipeline":  return .pink
        default:          return .gray
        }
    }
}
