import Foundation

// Recently-issued tasks, recovered from nyx.md. The audit DB records task ids
// and lifecycle events but never the task TEXT or spec tags, so the queue file
// is the only recoverable source: insertUnderActiveTasks splices new tasks at
// the TOP of `## Active Tasks` and markTaskCompleted inserts finished blocks at
// the TOP of `## Completed` (both in apps/dispatcher/src/task-reader.ts), so
// reading each section top-down yields newest-first without timestamps. Used by
// the add-flow Recent step and the Manage Templates promote affordance — both
// call the async fetch (file IO off the main actor; never resolve in body).
struct RecentTask: Identifiable, Hashable {
    let id: String
    let title: String
    let type: String
    let model: String?
    let gate: String?
    let priority: String
    let repo: String?
    let schedule: String?   // "slot:N" | "every:K" | nil (standing)
    let text: String        // title + continuation prose, tags stripped — re-issuable
    let completed: Bool

    // The add-flow is kind-scoped: pipelines are workflows, everything else a task.
    var kind: String { type == "pipeline" ? "workflow" : "task" }
}

enum RecentTasks {
    // Async accessor following the AppsStore/DashboardStore refresh posture:
    // the parse runs detached, the caller awaits a value-type batch.
    static func fetch(limit: Int = 10) async -> [RecentTask] {
        await Task.detached(priority: .utility) { load(limit: limit) }.value
    }

    // Active section first (newest at the top), then Completed (newest at the
    // top): the closest recoverable approximation of issue order.
    nonisolated static func load(limit: Int = 10) -> [RecentTask] {
        guard let text = try? String(contentsOf: Layout.queuePath, encoding: .utf8) else { return [] }
        let lines = text.components(separatedBy: .newlines)
        let active = parseSection(lines, header: #"^##\s+Active Tasks\s*$"#)
        let completed = parseSection(lines, header: #"^##\s+Completed\s*$"#)
        return Array((active + completed).prefix(limit))
    }

    // Parse one section's task blocks: a `- [ ]` / `- [x]` head line plus its
    // indented continuation, ending at the next head or `## ` header. Mirrors
    // QueueFile.load's windowing; kept separate because this needs the
    // completed marker and the full re-issuable text, not calendar placement.
    private static func parseSection(_ lines: [String], header: String) -> [RecentTask] {
        guard let start = lines.firstIndex(where: {
            $0.range(of: header, options: .regularExpression) != nil
        }) else { return [] }

        var items: [RecentTask] = []
        var i = start + 1
        while i < lines.count {
            let line = lines[i]
            if line.range(of: #"^##\s+"#, options: .regularExpression) != nil { break }
            guard let range = line.range(of: #"^\s*-\s*\[( |x|X)\]\s*"#, options: .regularExpression) else {
                i += 1
                continue
            }
            let done = line.range(of: #"^\s*-\s*\[(x|X)\]"#, options: .regularExpression) != nil
            let rest = String(line[range.upperBound...])
            let id: String
            let title: String
            if let sep = rest.range(of: #"\s+[—-]\s+"#, options: .regularExpression) {
                id = String(rest[..<sep.lowerBound]).trimmingCharacters(in: .whitespaces)
                title = String(rest[sep.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else {
                id = rest.trimmingCharacters(in: .whitespaces)
                title = ""
            }

            var end = i + 1
            while end < lines.count,
                  lines[end].range(of: #"^\s*-\s*\[[ xX]\]\s*"#, options: .regularExpression) == nil,
                  lines[end].range(of: #"^##\s+"#, options: .regularExpression) == nil {
                end += 1
            }
            let window = lines[i..<end].joined(separator: "\n")

            items.append(RecentTask(
                id: id,
                title: title,
                type: firstMatch(#"\[type:\s*([a-zA-Z]+)\]"#, in: window) ?? "—",
                model: firstMatch(#"\[model:\s*([a-zA-Z]+)\]"#, in: window),
                gate: firstMatch(#"\[gate:\s*([a-zA-Z,]+)\]"#, in: window),
                priority: (firstMatch(#"\[priority:\s*(high|normal|low)\]"#, in: window) ?? "normal").lowercased(),
                repo: firstMatch(#"\[repo:\s*([^\]\s]+)\]"#, in: window),
                schedule: scheduleString(window),
                text: reissuableText(title: title, window: window),
                completed: done))
            i = end
        }
        return items
    }

    private static func scheduleString(_ window: String) -> String? {
        if let slot = firstMatch(#"\[slot:\s*(\d+)\]"#, in: window) { return "slot:\(slot)" }
        if let every = firstMatch(#"\[every:\s*([0-9]+\s*[mhd])\]"#, in: window) {
            return "every:\(every.replacingOccurrences(of: " ", with: ""))"
        }
        return nil
    }

    // The full plain-language description, suitable for re-dispatch: head title
    // plus any continuation prose, with every [tag: …] block and the completion
    // bookkeeping line stripped.
    private static func reissuableText(title: String, window: String) -> String {
        var text = window
        text = text.replacingOccurrences(
            of: #"^\s*-\s*\[[ xX]\]\s*[^\n]*?\s+[—-]\s+"#, with: "",
            options: .regularExpression)
        text = text.replacingOccurrences(
            of: #"\[[a-z]+:[^\]]*\]"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? title : text
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1 else { return nil }
        return ns.substring(with: m.range(at: 1))
    }
}
