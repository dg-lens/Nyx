import SwiftUI

// The right 1/5: the standing tasks in order. A count header with a slight top
// margin, then compact bubbles — each at most 2 lines tall: line 1 = id + type
// + priority badges, line 2 = a one-sentence (truncated) description.
struct StandingTasksColumn: View {
    let tasks: [QueueItem]

    // Order: priority (high→low) then file order (stable, as parsed). Mirrors the
    // dispatcher's standing-list sort so the operator sees the pick order.
    private var ordered: [QueueItem] {
        let rank: [String: Int] = ["high": 0, "normal": 1, "low": 2]
        return tasks.enumerated().sorted { a, b in
            let ra = rank[a.element.priority] ?? 1, rb = rank[b.element.priority] ?? 1
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map { $0.element }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "tray.full").font(.caption).foregroundStyle(.secondary)
                Text("Standing").font(.callout.weight(.semibold))
                Spacer()
                Text("\(tasks.count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
            .padding(.top, 6)

            if ordered.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "tray").font(.title2).foregroundStyle(.tertiary)
                    Text("No standing tasks")
                        .font(.caption).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity).padding(.top, 40)
            } else {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(ordered) { StandingBubble(task: $0) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

private struct StandingBubble: View {
    let task: QueueItem

    private var tint: Color { TaskPalette.color(task.type) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Line 1: id + type + priority.
            HStack(spacing: 6) {
                Text(task.id)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Text(task.type)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(tint.opacity(0.16), in: Capsule())
                PriorityBadge(priority: task.priority)
            }
            // Line 2: one-sentence description, single line, truncated.
            Text(task.detail.isEmpty ? task.title : task.detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        .help(task.detail.isEmpty ? task.title : task.detail)
    }
}

private struct PriorityBadge: View {
    let priority: String

    private var color: Color {
        switch priority {
        case "high": return .red
        case "low":  return .secondary
        default:     return .secondary
        }
    }

    var body: some View {
        Text(priority)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(priority == "high" ? color : .secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background((priority == "high" ? color : Color.secondary).opacity(0.15), in: Capsule())
    }
}
