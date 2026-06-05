import SwiftUI

struct DispatchView: View {
    @EnvironmentObject var store: Store
    @State private var text = ""
    @State private var type = "code"
    @State private var model = "auto"
    @State private var priority = "normal"
    @State private var repo = ""
    @State private var schedule = "standing"
    @State private var atTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var recurEvery = "6h"

    private let types = ["code", "analysis", "assistant", "content", "pipeline"]
    private let priorities = ["high", "normal", "low"]

    private var scheduleString: String {
        switch schedule {
        case "atTime":
            let c = Calendar.current.dateComponents([.hour, .minute], from: atTime)
            let slot = (c.hour ?? 0) * 12 + (c.minute ?? 0) / 5
            return "slot:\(slot)"
        case "recurring":
            return "every:\(recurEvery)"
        default:
            return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Describe work in plain language. A sonnet pass breaks it into one or more fully-tagged tasks — you don't write the task syntax.")
                .font(.caption).foregroundStyle(.secondary)

            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 110)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Type") {
                    Picker("", selection: $type) { ForEach(types, id: \.self) { Text($0) } }
                        .labelsHidden().fixedSize()
                }
                labeled("Model") {
                    Picker("", selection: $model) {
                        Text("Auto-Detect").tag("auto")
                        Text("haiku").tag("haiku")
                        Text("sonnet").tag("sonnet")
                        Text("opus").tag("opus")
                    }
                    .labelsHidden().fixedSize()
                }
                labeled("Priority") {
                    Picker("", selection: $priority) { ForEach(priorities, id: \.self) { Text($0) } }
                        .labelsHidden().fixedSize()
                }
                Spacer()
            }

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Schedule") {
                    Picker("", selection: $schedule) {
                        Text("Standing").tag("standing")
                        Text("Daily at time").tag("atTime")
                        Text("Recurring").tag("recurring")
                    }.labelsHidden().fixedSize()
                }
                if schedule == "atTime" {
                    labeled("Time of day") {
                        DatePicker("", selection: $atTime, displayedComponents: .hourAndMinute)
                            .labelsHidden()
                    }
                } else if schedule == "recurring" {
                    labeled("Every") {
                        Picker("", selection: $recurEvery) {
                            Text("3 hours").tag("3h")
                            Text("6 hours").tag("6h")
                            Text("12 hours").tag("12h")
                            Text("Daily").tag("24h")
                            Text("Weekly").tag("7d")
                        }.labelsHidden().fixedSize()
                    }
                }
                Spacer()
            }

            HStack(alignment: .bottom) {
                labeled("Repo (optional)") {
                    TextField("org/name", text: $repo)
                        .textFieldStyle(.roundedBorder).frame(width: 240)
                }
                Spacer()
                Button {
                    store.dispatch(text: text, type: type, model: model, priority: priority,
                                   repo: repo.isEmpty ? nil : repo, schedule: scheduleString)
                    text = ""
                } label: {
                    if store.ticking {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Decomposing…") }
                    } else {
                        Label("Decompose & Queue", systemImage: "wand.and.stars")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || store.ticking)
            }

            if !store.lastDispatch.isEmpty {
                Text(store.lastDispatch).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func labeled<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            content()
        }
    }
}
