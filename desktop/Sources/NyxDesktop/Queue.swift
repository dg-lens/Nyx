import Foundation

enum QueueFile {
    static func load() -> [QueueItem] {
        guard let text = try? String(contentsOf: Layout.queuePath, encoding: .utf8) else { return [] }
        let lines = text.components(separatedBy: .newlines)
        var items: [QueueItem] = []

        for (i, line) in lines.enumerated() {
            guard let range = line.range(of: #"^\s*-\s*\[ \]\s*"#, options: .regularExpression) else { continue }
            let rest = String(line[range.upperBound...])
            let parts = rest.components(separatedBy: "—")
            let id = parts.first?.trimmingCharacters(in: .whitespaces) ?? rest
            let title = parts.count > 1
                ? parts[1...].joined(separator: "—").trimmingCharacters(in: .whitespaces)
                : ""

            let window = ([line] + lines[(i + 1)..<min(i + 4, lines.count)]).joined(separator: "\n")
            let type = firstMatch(#"\[type:\s*([a-zA-Z]+)\]"#, in: window) ?? "—"

            items.append(QueueItem(id: id, title: title, type: type))
        }
        return items
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1 else { return nil }
        return ns.substring(with: m.range(at: 1))
    }
}
