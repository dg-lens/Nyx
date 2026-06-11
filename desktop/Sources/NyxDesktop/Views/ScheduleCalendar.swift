import SwiftUI

// A week calendar in the apple/google-calendar layout: 24 hour-rows tall by 7
// day-columns wide, hour labels down the left, day headers across the top,
// vertically scrollable. Scheduled tasks render as small chips in the cell for
// their fire-time. Daily [slot:] tasks and cadence [every:] tasks appear in all
// 7 day-columns (they fire every day); the chip is colored by task type.
struct ScheduleCalendar: View {
    let tasks: [QueueItem]

    private let hourHeight: CGFloat = 38
    private let hourLabelWidth: CGFloat = 44
    private let dayHeaderHeight: CGFloat = 26
    private let days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    // Fire-slots per task, then grouped by hour for cell placement. A task can
    // fire at several slots a day (cadence); each becomes its own chip instance.
    private struct Fire: Identifiable {
        let id: String
        let task: QueueItem
        let slot: Int
    }

    private var fires: [Fire] {
        var out: [Fire] = []
        for t in tasks {
            if let s = t.slot {
                out.append(Fire(id: "\(t.id)@\(s)", task: t, slot: s))
            } else if let step = t.everyStepSlots {
                for s in Schedule.cadenceFireSlots(step: step) {
                    out.append(Fire(id: "\(t.id)@\(s)", task: t, slot: s))
                }
            }
        }
        return out
    }

    // chips that fall within a given hour, sorted by minute then id.
    private func fires(inHour hour: Int) -> [Fire] {
        fires
            .filter { Schedule.hourMinute($0.slot).hour == hour }
            .sorted {
                let a = Schedule.hourMinute($0.slot), b = Schedule.hourMinute($1.slot)
                return a.minute != b.minute ? a.minute < b.minute : $0.id < $1.id
            }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                gridBody
            }
        }
        .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
    }

    private var header: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: hourLabelWidth)
            ForEach(days, id: \.self) { d in
                Text(d)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(height: dayHeaderHeight)
        .padding(.trailing, 4)
    }

    private var gridBody: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 0) {
                    Text(Schedule.slotToTime(hour * Schedule.slotsPerHour))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .frame(width: hourLabelWidth, height: hourHeight, alignment: .topTrailing)
                        .padding(.trailing, 6)
                        .offset(y: -5)
                    ForEach(0..<7, id: \.self) { _ in
                        dayCell(hour: hour)
                    }
                }
                Divider()
            }
        }
        .padding(.trailing, 4)
    }

    // One day-column cell for one hour. Daily/cadence tasks fire on every day, so
    // each of the 7 columns shows the same chips for a given hour.
    private func dayCell(hour: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(fires(inHour: hour)) { f in
                ScheduleChip(task: f.task, slot: f.slot)
            }
        }
        .frame(maxWidth: .infinity, minHeight: hourHeight, alignment: .topLeading)
        .padding(.horizontal, 3)
        .padding(.top, 2)
        .overlay(
            Rectangle().frame(width: 1).foregroundStyle(.quaternary.opacity(0.5)),
            alignment: .leading)
    }
}

// A small task chip placed in a calendar cell: the task id, tinted by type, with
// a colored leading bar. Tooltip carries the full schedule + description.
struct ScheduleChip: View {
    let task: QueueItem
    let slot: Int

    private var tint: Color { TaskPalette.color(task.type) }

    private var scheduleLabel: String {
        if task.slot != nil { return "daily \(Schedule.slotToTime(slot))" }
        if let step = task.everyStepSlots { return Schedule.everyLabel(stepSlots: step) }
        return Schedule.slotToTime(slot)
    }

    var body: some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 1.5).fill(tint).frame(width: 3)
            Text(task.id)
                .font(.system(size: 9, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 5))
        .help("\(task.id) · \(task.type) · \(scheduleLabel)\(task.detail.isEmpty ? "" : "\n\(task.detail)")")
    }
}
