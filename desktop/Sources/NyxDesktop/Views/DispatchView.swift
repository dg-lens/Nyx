import SwiftUI

struct DispatchView: View {
    @EnvironmentObject var store: Store
    @State private var text = ""
    @State private var type = "code"
    @State private var repo = ""

    private let types = ["code", "analysis", "assistant", "content", "pipeline"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Describe work in natural language — it's queued to \(store.systemName).md for the dispatcher to decompose and run.")
                .font(.caption).foregroundStyle(.secondary)

            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

            HStack {
                Picker("", selection: $type) {
                    ForEach(types, id: \.self) { Text($0) }
                }
                .labelsHidden().fixedSize()

                TextField("repo (org/name, optional)", text: $repo)
                    .textFieldStyle(.roundedBorder)

                Button("Queue") {
                    store.dispatch(text: text, type: type, repo: repo.isEmpty ? nil : repo)
                    text = ""
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if !store.lastDispatch.isEmpty {
                Text(store.lastDispatch).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}
