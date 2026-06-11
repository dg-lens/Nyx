import Foundation

// Produces the StatusPayload backing a status-viz widget. Two entry points:
//
//   * resolveFile  — a read-only file-tail source (manifest `source.kind == "file"`).
//     Reads the file at the (expanded) path, renders the last `maxLines` non-empty
//     lines, derives fresh/stale from mtime vs `freshMinutes`, and NEVER throws —
//     a missing/unreadable file becomes an `.error` payload.
//
//   * resolveStore — the nyx-ops composite store keys ("ops.dispatcher", "ops.gates",
//     "ops.queue", "ops.ledger"). Each key is its own do/catch: a throwing resolver
//     yields the error freshness state for THAT widget only and never blanks siblings.
//
// HARD RULE: this file performs ONLY file reads + in-memory Store reads. It must
// never spawn a Process / shell / command — status widgets are operator-droppable
// JSON and a command source would be an arbitrary-code-execution vector.
enum StatusResolver {

    // MARK: Public entry

    static func resolve(_ source: WidgetSource, _ state: NyxState) -> StatusPayload {
        switch source {
        case .file(let path, let freshMinutes, let maxLines):
            return resolveFile(path: path, freshMinutes: freshMinutes, maxLines: maxLines)
        case .store(let key):
            return resolveStore(key, state)
        case .staticText:
            return .preparing
        }
    }

    // MARK: File source (read-only)

    // Expand ~ and $NYX_DATA_DIR, read the tail, derive freshness from mtime. The
    // whole body is wrapped so any failure becomes an `.error` payload rather than
    // a throw — the never-throws contract the file source promises.
    static func resolveFile(path rawPath: String, freshMinutes: Int, maxLines: Int) -> StatusPayload {
        let expanded = expandPath(rawPath)
        let fm = FileManager.default
        guard fm.fileExists(atPath: expanded) else {
            return .error("file not found")
        }
        do {
            let raw = try String(contentsOfFile: expanded, encoding: .utf8)
            let mtime = (try? fm.attributesOfItem(atPath: expanded))?[.modificationDate] as? Date
            let lines = lastNonEmptyLines(raw, limit: maxLines)
            return payload(lines: lines, mtime: mtime, freshMinutes: freshMinutes,
                           emptyState: .preparing)
        } catch {
            return .error("unreadable")
        }
    }

    // MARK: nyx-ops composite store keys

    private static func resolveStore(_ key: String, _ state: NyxState) -> StatusPayload {
        switch key {
        case "ops.dispatcher": return isolate { try opsDispatcher() }
        case "ops.gates":      return isolate { opsGates(state) }
        case "ops.queue":      return isolate { opsQueue(state) }
        case "ops.ledger":     return isolate { try opsLedger() }
        default:               return .preparing
        }
    }

    // Per-source failure isolation: a throwing closure yields the error state for
    // THIS widget only. Sibling widgets call isolate independently.
    private static func isolate(_ body: () throws -> StatusPayload) -> StatusPayload {
        do { return try body() } catch { return .error(shortMessage(error)) }
    }

    // ops.dispatcher — heartbeat from $NYX_DATA_DIR/data/last-tick-ok (epoch seconds).
    // ok < 10min, warn < 30min, critical beyond/missing. update-failed.marker present
    // forces critical + a line. No Process: the watchdog-plist hint needs a shell
    // probe, so it's omitted entirely (the rule is "omit if it needs Process").
    private static func opsDispatcher() throws -> StatusPayload {
        let dataDir = Layout.dataDir.appendingPathComponent("data")
        let tickFile = dataDir.appendingPathComponent("last-tick-ok")
        let markerFile = dataDir.appendingPathComponent("update-failed.marker")
        let fm = FileManager.default

        var lines: [String] = []
        var health: HealthLevel = .ok
        var freshDate: Date? = nil
        var state: FreshnessState = .preparing

        let markerPresent = fm.fileExists(atPath: markerFile.path)

        if let raw = try? String(contentsOf: tickFile, encoding: .utf8),
           let epoch = TimeInterval(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            let tickDate = Date(timeIntervalSince1970: epoch)
            let ageMin = Date().timeIntervalSince(tickDate) / 60
            freshDate = tickDate
            lines.append("last healthy tick \(Relative.string(from: tickDate))")
            if ageMin < 10 {
                health = .ok
                state = .fresh(tickDate)
            } else if ageMin < 30 {
                health = .warn
                state = .stale(tickDate)
            } else {
                health = .critical
                state = .stale(tickDate)
            }
        } else {
            lines.append("no heartbeat yet (data/last-tick-ok missing)")
            health = .critical
            state = .preparing
        }

        if markerPresent {
            health = .critical
            lines.append("update-failed marker present — self-update failed")
        }

        return StatusPayload(health: health, lines: Array(lines.prefix(7)),
                             freshnessDate: freshDate, state: state)
    }

    // ops.gates — warn when any gate is waiting, else ok. Lines = up to 7 gate
    // one-liners from the live Store. Freshness from the most-recent tick string.
    private static func opsGates(_ state: NyxState) -> StatusPayload {
        let gates = state.gates
        let lines: [String]
        if gates.isEmpty {
            lines = ["no gates waiting"]
        } else {
            lines = gates.prefix(7).map { g in
                let label = g.gate.isEmpty ? "gate" : g.gate
                let repo = g.repo.isEmpty ? "" : " · \(g.repo)"
                return "\(label): \(g.summary)\(repo)"
            }
        }
        let fresh = tickDate(state)
        return StatusPayload(
            health: gates.isEmpty ? .ok : .warn,
            lines: lines,
            freshnessDate: fresh,
            state: fresh.map { .fresh($0) } ?? .preparing)
    }

    // ops.queue — standing/active counts + the next few task ids. Health ok.
    private static func opsQueue(_ state: NyxState) -> StatusPayload {
        let queue = state.queue
        let standing = queue.filter { $0.isStanding }.count
        let scheduled = queue.count - standing
        var lines: [String] = ["\(queue.count) queued · \(standing) standing · \(scheduled) scheduled"]
        for q in queue.prefix(6) {
            lines.append("\(q.id) — \(q.title)")
        }
        let fresh = tickDate(state)
        return StatusPayload(
            health: .ok,
            lines: Array(lines.prefix(7)),
            freshnessDate: fresh,
            state: fresh.map { .fresh($0) } ?? .preparing)
    }

    // ops.ledger — $NYX_DATA_DIR/ledger/LEDGER.md, the most recent day's entry
    // lines stripped to plain sentences. fresh < 20min from mtime. A missing file
    // is `.preparing` (the ledger renders at tick end, so absence is "not yet").
    private static func opsLedger() throws -> StatusPayload {
        let ledger = Layout.dataDir.appendingPathComponent("ledger/LEDGER.md")
        let fm = FileManager.default
        guard fm.fileExists(atPath: ledger.path) else {
            return .preparing
        }
        let raw = try String(contentsOf: ledger, encoding: .utf8)
        let mtime = (try? fm.attributesOfItem(atPath: ledger.path))?[.modificationDate] as? Date
        let lines = mostRecentDayLines(raw, limit: 7)
        if lines.isEmpty {
            // File exists but no day entries yet — still "preparing".
            return StatusPayload(health: .unknown, lines: [], freshnessDate: mtime, state: .preparing)
        }
        return payload(lines: lines, mtime: mtime, freshMinutes: 20, emptyState: .preparing)
    }

    // MARK: Shared helpers

    // Build a payload from rendered lines + mtime. fresh when mtime is within
    // freshMinutes, stale beyond, preparing when there are no lines at all.
    private static func payload(lines: [String], mtime: Date?, freshMinutes: Int,
                                emptyState: FreshnessState) -> StatusPayload {
        guard !lines.isEmpty else {
            return StatusPayload(health: .unknown, lines: [], freshnessDate: mtime, state: emptyState)
        }
        guard let mtime else {
            return StatusPayload(health: .ok, lines: lines, freshnessDate: nil, state: .fresh(Date()))
        }
        let ageMin = Date().timeIntervalSince(mtime) / 60
        if ageMin <= Double(freshMinutes) {
            return StatusPayload(health: .ok, lines: lines, freshnessDate: mtime, state: .fresh(mtime))
        } else {
            return StatusPayload(health: .warn, lines: lines, freshnessDate: mtime, state: .stale(mtime))
        }
    }

    // Last `limit` non-empty trimmed lines, in file order.
    private static func lastNonEmptyLines(_ raw: String, limit: Int) -> [String] {
        let all = raw
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return Array(all.suffix(max(0, limit)))
    }

    // Parse LEDGER.md: find the first `## <day>` header (newest first in the doc),
    // collect that day's `- ...` bullet lines, strip the markdown decoration
    // (`\`HH:MM\``, `**[actor]**`, leading bullet, `### Section`), return plain
    // sentences up to `limit`.
    private static func mostRecentDayLines(_ raw: String, limit: Int) -> [String] {
        var out: [String] = []
        var inDay = false
        for rawLine in raw.split(whereSeparator: { $0.isNewline }) {
            let line = String(rawLine).trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("## ") {
                if inDay { break }   // reached the next day — stop
                inDay = true
                continue
            }
            guard inDay else { continue }
            if line.hasPrefix("- ") || line.hasPrefix("* ") {
                let plain = stripLedgerMarkup(String(line.dropFirst(2)))
                if !plain.isEmpty { out.append(plain) }
                if out.count >= limit { break }
            }
        }
        return out
    }

    // Strip `\`HH:MM\``, bold `**[actor]**`, and stray markdown emphasis from a
    // ledger bullet, leaving a plain sentence.
    private static func stripLedgerMarkup(_ s: String) -> String {
        var t = s
        // Drop a leading backtick-quoted time stamp.
        if let firstTick = t.firstIndex(of: "`"),
           let secondTick = t[t.index(after: firstTick)...].firstIndex(of: "`") {
            t.removeSubrange(firstTick...secondTick)
        }
        t = t.replacingOccurrences(of: "**", with: "")
        // Drop a leading `[actor]` tag if present.
        let trimmed = t.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("["), let close = trimmed.firstIndex(of: "]") {
            t = String(trimmed[trimmed.index(after: close)...])
        }
        return t.trimmingCharacters(in: .whitespaces)
    }

    // Expand a leading ~ and any $NYX_DATA_DIR occurrence to an absolute path.
    private static func expandPath(_ path: String) -> String {
        var p = path
        if p.contains("$NYX_DATA_DIR") {
            p = p.replacingOccurrences(of: "$NYX_DATA_DIR", with: Layout.dataDir.path)
        }
        return NSString(string: p).expandingTildeInPath
    }

    private static func tickDate(_ state: NyxState) -> Date? {
        // The Store exposes last tick as a preformatted string; we only have a
        // truthy "we have ticked" signal here, so treat a non-placeholder value
        // as "fresh now" for the footer. A precise mtime isn't available without
        // re-reading the heartbeat file (ops.dispatcher owns that).
        state.lastTick != "—" && !state.lastTick.isEmpty ? Date() : nil
    }

    private static func shortMessage(_ error: Error) -> String {
        let m = error.localizedDescription
        return String(m.prefix(60))
    }
}

// Compact relative-time formatter for footers + heartbeat lines: "now" / "12s" /
// "4m" / "2h" / "3d". Adapted from the IrisLiveOps QuadrantCard.relative helper.
enum Relative {
    static func string(from date: Date) -> String {
        let secs = Int(max(0, Date().timeIntervalSince(date)))
        if secs < 5 { return "now" }
        if secs < 60 { return "\(secs)s ago" }
        let mins = secs / 60
        if mins < 60 { return "\(mins)m ago" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs)h ago" }
        let days = hrs / 24
        return "\(days)d ago"
    }
}
