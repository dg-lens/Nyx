import Foundation

enum QueueFile {
    static func load() -> [QueueItem] {
        guard let text = try? String(contentsOf: Layout.queuePath, encoding: .utf8) else { return [] }
        let lines = text.components(separatedBy: .newlines)
        // Only parse between `## Active Tasks` and the next `## ` header — not the
        // whole file (the doc-reference section also contains a `- [ ]` example).
        guard let start = lines.firstIndex(where: {
            $0.range(of: #"^##\s+Active Tasks\s*$"#, options: .regularExpression) != nil
        }) else { return [] }

        var items: [QueueItem] = []
        var i = start + 1
        while i < lines.count {
            let line = lines[i]
            if line.range(of: #"^##\s+"#, options: .regularExpression) != nil { break }
            guard let range = line.range(of: #"^\s*-\s*\[ \]\s*"#, options: .regularExpression) else {
                i += 1
                continue
            }
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
                  lines[end].range(of: #"^\s*-\s*\[[ x]\]\s*"#, options: .regularExpression) == nil,
                  lines[end].range(of: #"^##\s+"#, options: .regularExpression) == nil {
                end += 1
            }
            let window = lines[i..<end].joined(separator: "\n")
            let type = firstMatch(#"\[type:\s*([a-zA-Z]+)\]"#, in: window) ?? "—"
            let priority = (firstMatch(#"\[priority:\s*(high|normal|low)\]"#, in: window) ?? "normal").lowercased()

            // [slot:] XOR [every:]. Parse each independently; if both somehow appear,
            // mirror the dispatcher (invalid) by treating it as standing — drop both.
            var slot: Int? = nil
            if let raw = firstMatch(#"\[slot:\s*(\d+)\]"#, in: window), let n = Int(raw),
               n >= 0, n < Schedule.slotsPerDay {
                slot = n
            }
            var every: Int? = nil
            if let raw = firstMatch(#"\[every:\s*([0-9]+\s*[mhd])\]"#, in: window) {
                every = Schedule.everyStep(raw)
            }
            if slot != nil && every != nil { slot = nil; every = nil }

            // One-sentence body: the continuation text minus the bracketed tags and
            // the leading bullet. Title already holds the head; detail is the first
            // sentence of whatever prose the task carries (often the head itself).
            let detail = Self.oneSentence(title: title, window: window)

            items.append(QueueItem(
                id: id, title: title, type: type,
                priority: priority, slot: slot, everyStepSlots: every, detail: detail))
            i += 1
        }
        return items
    }

    // First sentence of the task's prose, tag-stripped, for the standing bubble's
    // second line. Falls back to the head title when the body is all tags.
    private static func oneSentence(title: String, window: String) -> String {
        var text = window
        // Strip the leading "- [ ] ID — " head and every [tag: …] block.
        text = text.replacingOccurrences(
            of: #"^\s*-\s*\[ \]\s*[^\n]*?[—-]\s*"#, with: "",
            options: .regularExpression)
        text = text.replacingOccurrences(
            of: #"\[[a-z]+:[^\]]*\]"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let body = text.isEmpty ? title : text
        if let dot = body.range(of: #"[.!?](\s|$)"#, options: .regularExpression) {
            return String(body[..<dot.upperBound]).trimmingCharacters(in: .whitespaces)
        }
        return body
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1 else { return nil }
        return ns.substring(with: m.range(at: 1))
    }
}
