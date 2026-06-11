import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum Database {
    // MARK: reads

    private static func query(_ sql: String) -> [[String: String]] {
        var handle: OpaquePointer?
        // Open read-write, not read-only: the dispatcher runs the DB in WAL mode,
        // and a read-only connection cannot open a WAL database it didn't create
        // (SQLITE_CANTOPEN), so every read would return empty after a tick.
        guard sqlite3_open_v2(Layout.dbPath.path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_close(handle) }
        // WAL writers (dispatcher tick) can return SQLITE_BUSY to a concurrent
        // reader; block-and-retry for up to 3s instead of returning [] and
        // flickering the UI to empty mid-tick.
        sqlite3_busy_timeout(handle, 3000)
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var rows: [[String: String]] = []
        let cols = sqlite3_column_count(stmt)
        while sqlite3_step(stmt) == SQLITE_ROW {
            var row: [String: String] = [:]
            for i in 0..<cols {
                let name = String(cString: sqlite3_column_name(stmt, i))
                if let c = sqlite3_column_text(stmt, i) {
                    row[name] = String(cString: c)
                } else {
                    row[name] = ""
                }
            }
            rows.append(row)
        }
        return rows
    }

    static func loadGates() -> [Gate] {
        let sql = """
        SELECT id, status, current_stage, prompt, repo, bz_brief_path, plan_json, operator_decision
        FROM pipeline_runs
        WHERE status IN ('awaiting_preview', 'awaiting_review')
        ORDER BY updated_at DESC
        """
        // A run can sit in awaiting_* with a decision already recorded (up to one
        // tick / ~5 min) before the tick consumes it. Drop those: re-showing live
        // action buttons invites a double-submit that overwrites the first answer.
        return query(sql).filter { ($0["operator_decision"] ?? "").isEmpty }.map { r in
            let gate = (r["status"] == "awaiting_review") ? "review" : "preview"
            var summary = r["prompt"] ?? ""
            let brief = r["bz_brief_path"] ?? ""
            if !brief.isEmpty, let txt = try? String(contentsOfFile: brief, encoding: .utf8), !txt.isEmpty {
                summary = recommendationLine(txt) ?? summary
            } else if let stage = r["current_stage"], !stage.isEmpty {
                summary += " (stage: \(stage))"
            }
            let runId = r["id"] ?? ""
            // Planning decisions (alignment.decisions) belong to the PREVIEW gate
            // only: they were answered there and baked into the coders. The REVIEW
            // gate is about the BUILT result (proceed/fix/rollback) — re-showing the
            // frozen planning questions there is stale and confusing.
            let decisions = gate == "preview"
                ? parseDecisions(r["plan_json"] ?? "", saved: loadSavedAnswers(runId))
                : []
            // Preflight requirements (env vars / toolchain) are planning-time and
            // are provisioned at the PREVIEW gate. Their frozen plan_json status is
            // stale by the review gate (e.g. ADMIN_TOKEN still shows "missing" after
            // you set it), so don't re-show them — the review gate is the built result.
            let preflight = gate == "preview" ? parsePreflight(r["plan_json"] ?? "") : []
            return Gate(id: runId, gate: gate, summary: summary, repo: r["repo"] ?? "",
                        preflight: preflight,
                        decisions: decisions)
        }
    }

    // Previously-submitted answers from <run>.decisions.json, keyed by question, so
    // a re-opened preview (e.g. after a revise) reflects what was already answered
    // instead of resetting to the planner's defaults.
    private static func loadSavedAnswers(_ runId: String) -> [String: String] {
        let path = Layout.runDecisionsPath(runId).path
        guard let data = FileManager.default.contents(atPath: path),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [:] }
        var out: [String: String] = [:]
        for d in arr {
            if let q = d["question"] as? String, let a = d["answer"] as? String { out[q] = a }
        }
        return out
    }

    private static func parseDecisions(_ planJson: String, saved: [String: String]) -> [GateDecision] {
        guard let data = planJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let align = obj["alignment"] as? [String: Any],
              let items = align["decisions"] as? [[String: Any]] else { return [] }
        return items.compactMap { d in
            guard let q = d["question"] as? String, !q.isEmpty else { return nil }
            return GateDecision(question: q, defaultAnswer: d["default"] as? String, savedAnswer: saved[q])
        }
    }

    // The card shows a clean go/no-go recommendation, not the raw brief markdown:
    // the bold recommendation line ("GO — 3 tasks…" / "NEEDS INPUT — …").
    private static func recommendationLine(_ brief: String) -> String? {
        for raw in brief.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("**"), line.hasSuffix("**"), line.count > 4 {
                return String(line.dropFirst(2).dropLast(2))
            }
        }
        return nil
    }

    // alignment.preflight from the frozen plan_json (PlanningResult).
    private static func parsePreflight(_ planJson: String) -> [PreflightReq] {
        guard let data = planJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let align = obj["alignment"] as? [String: Any],
              let items = align["preflight"] as? [[String: Any]] else { return [] }
        return items.map { p in
            PreflightReq(
                item: (p["item"] as? String) ?? "",
                status: (p["status"] as? String) ?? "unclear",
                note: (p["note"] as? String) ?? "",
                env: p["env"] as? String
            )
        }
    }

    static func loadAudit(limit: Int = 120) -> [AuditRow] {
        let rows = query("SELECT at, event, payload FROM system_audit ORDER BY id DESC LIMIT \(limit)")
        return rows.map { r in
            let payload = r["payload"] ?? ""
            let sid = subjectId(payload)
            return AuditRow(at: shortTime(r["at"] ?? ""), event: r["event"] ?? "",
                            detail: detailFrom(payload, subjectId: sid), subjectId: sid)
        }
    }

    static func lastTick() -> String? {
        let rows = query("SELECT at FROM system_audit WHERE event = 'dispatch.tick' ORDER BY id DESC LIMIT 1")
        guard let at = rows.first?["at"], !at.isEmpty else { return nil }
        return shortTime(at)
    }

    // Pending dispatches: queue_task actions written (e.g. from the Dispatch tab)
    // but not yet drained into nyx.md by a tick. Shown so a just-queued task is
    // visible immediately rather than only appearing for the instant between
    // drain and execution.
    static func loadPendingQueue() -> [QueueItem] {
        let rows = query("SELECT id, action, params FROM pending_actions WHERE action IN ('queue_task', 'decompose_task') AND status = 'pending' ORDER BY id")
        return rows.compactMap { r in
            guard let p = r["params"], let data = p.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            let text = (obj["text"] as? String) ?? (obj["raw"] as? String) ?? "(queued task)"
            let type = (obj["type"] as? String) ?? "task"
            let label = r["action"] == "decompose_task" ? "\(type) · decomposing" : "\(type) · pending tick"
            return QueueItem(id: "queued #\(r["id"] ?? "?")", title: text, type: label)
        }
    }

    // MARK: write — control surface

    @discardableResult
    static func enqueueAction(_ action: String, params: [String: String]) -> Bool {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(Layout.dbPath.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK
        else { return false }
        defer { sqlite3_close(handle) }
        // WAL allows one writer at a time; a tick holding a write transaction
        // makes a second writer return SQLITE_BUSY. Block-and-retry for up to 3s
        // so an operator decision isn't silently lost on contention.
        sqlite3_busy_timeout(handle, 3000)
        sqlite3_exec(handle, """
        CREATE TABLE IF NOT EXISTS pending_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, params TEXT NOT NULL,
            source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT,
            created_at INTEGER NOT NULL, applied_at INTEGER);
        """, nil, nil, nil)

        let json = jsonString(params)
        let sql = "INSERT INTO pending_actions (action, params, source, status, created_at) VALUES (?, ?, 'desktop', 'pending', ?)"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, action, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, json, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int64(stmt, 3, Int64(Date().timeIntervalSince1970 * 1000))
        return sqlite3_step(stmt) == SQLITE_DONE
    }

    // MARK: helpers

    private static func jsonString(_ dict: [String: String]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoParserNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let localHM: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "HH:mm"
        return f
    }()

    // Audit timestamps are stored UTC (new Date().toISOString()); render in the
    // system's local timezone.
    private static func shortTime(_ iso: String) -> String {
        guard let date = isoParser.date(from: iso) ?? isoParserNoFrac.date(from: iso) else {
            return iso
        }
        return localHM.string(from: date)
    }

    // The task/run identifier this audit row is about, or nil if the event isn't
    // scoped to a subject (dispatch.tick, plugin.loaded, chain_verified, …).
    private static func subjectId(_ payload: String) -> String? {
        guard let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        for key in ["taskId", "runId", "task_id", "id"] {
            if let v = obj[key] as? String, !v.isEmpty { return v }
        }
        return nil
    }

    // A short human-readable detail derived from the payload — the operator-facing
    // "what happened" line. Skips the id keys (those become subjectId) and prefers
    // a small set of descriptive fields before falling back to the first scalar.
    private static func detailFrom(_ payload: String, subjectId: String?) -> String {
        guard let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        let idKeys: Set<String> = ["taskId", "runId", "task_id", "id"]
        for key in ["summary", "reason", "stage", "current_stage", "gate", "decision", "title", "message", "note", "type", "status", "target", "pattern"] {
            if let v = obj[key] as? String, !v.isEmpty, v != subjectId { return v }
        }
        for (k, v) in obj where !idKeys.contains(k) {
            if let s = v as? String, !s.isEmpty, s != subjectId { return "\(k): \(s)" }
            if let n = v as? Int { return "\(k): \(n)" }
            if let b = v as? Bool { return "\(k): \(b)" }
        }
        return ""
    }
}
