import SwiftUI

/// Start a bridge-hosted Claude session from the phone.
///
/// The bridge runs this session itself, so it stays alive with no terminal
/// watching — which is the point of bringing one into being from a device. The
/// `cwd` is a path on the bridge's machine, not this one, so it is typed rather
/// than browsed: a person knows their own project roots, and the bridge is the
/// one that has to find the directory. The project names already on the deck
/// are offered as quick fills, because they are the work this bridge runs —
/// and the directories its sessions already work in the same way, because a
/// path a session runs in is a path the bridge is known to reach.
struct StartSessionView: View {
    @Environment(DeckStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var projects: [String]
    /// Working directories from the current snapshot, most recently active
    /// first. Tapping one fills the field; typing stays open.
    var cwds: [String] = []

    @State private var project = ""
    @State private var cwd = ""
    @State private var objective = ""
    @State private var prompt = ""
    @State private var permission: ManagedPermissionMode = .default
    /// Nothing chosen means the runtime's own default, which is a better
    /// answer than any this sheet could invent.
    @State private var model: String?
    @State private var catalog: [RuntimeModel] = []
    @State private var working = false
    @State private var validationError: String?
    @State private var failure: BridgeError?
    @FocusState private var focus: Field?

    private enum Field { case project, cwd, objective, prompt }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    fields
                    if let validationError {
                        ValidationNote(message: validationError)
                    } else if let failure {
                        FailureNote(failure: failure)
                    }
                    startButton
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .task { catalog = await store.modelCatalog().flatMap(\.models) }
            .background(Palette.ink)
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.tint(Palette.muted)
                }
            }
            .toolbarBackground(Palette.ink, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .onAppear { if project.isEmpty { focus = .project } }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Start a session")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text("The bridge runs this session itself, so it stays on with no terminal watching. Give it a project and a working directory on the bridge's machine.")
                .font(.system(size: 14))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var fields: some View {
        VStack(spacing: 12) {
            LabelledField(label: "Project", hint: "The name this session is filed under.") {
                TextField("", text: $project, prompt: Text("project").foregroundStyle(Palette.muted))
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .project)
                    .submitLabel(.next)
                    .onSubmit { focus = .cwd }
            }
            // The project names this bridge already serves, as quick fills.
            if !projects.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(projects.prefix(8), id: \.self) { name in
                            Button {
                                project = name
                                failure = nil
                            } label: {
                                Text(name)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Palette.muted)
                                    .padding(.horizontal, 12)
                                    .frame(height: 30)
                                    .background(Capsule().fill(Palette.surface))
                                    .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .disabled(working)
                        }
                    }
                }
            }
            LabelledField(label: "Working directory", hint: "An absolute path on the bridge's machine.") {
                TextField("", text: $cwd, prompt: Text("/absolute/path/on/the/bridge").foregroundStyle(Palette.muted))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .cwd)
                    .submitLabel(.next)
                    .onSubmit { focus = .objective }
            }
            // The directories this bridge's sessions already work in, as quick
            // fills — the same idiom as the project names above.
            if !cwds.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(cwds.prefix(8), id: \.self) { path in
                            Button {
                                cwd = path
                                failure = nil
                            } label: {
                                Text(path)
                                    .font(.system(size: 12, design: .monospaced))
                                    .lineLimit(1)
                                    .foregroundStyle(Palette.muted)
                                    .padding(.horizontal, 12)
                                    .frame(height: 30)
                                    .background(Capsule().fill(Palette.surface))
                                    .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .disabled(working)
                        }
                    }
                }
            }
            LabelledField(label: "Objective", hint: "What this session is for. Optional.") {
                TextField("", text: $objective, prompt: Text("optional").foregroundStyle(Palette.muted))
                    .focused($focus, equals: .objective)
                    .submitLabel(.next)
                    .onSubmit { focus = .prompt }
            }
            LabelledField(label: "First message", hint: "Sent the moment the session starts. Optional.") {
                TextField("", text: $prompt, prompt: Text("optional").foregroundStyle(Palette.muted), axis: .vertical)
                    .lineLimit(1 ... 4)
                    .focused($focus, equals: .prompt)
            }
            if !catalog.isEmpty {
                modelPicker
            }
            permissionPicker
        }
        .disabled(working)
    }

    /// What the bridge was last told this account can reach. Only a running
    /// session can answer that, and there is none here — so an empty catalog
    /// means no choice is offered rather than a list we made up.
    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("MODEL")
                .font(.system(size: 10, weight: .bold))
                .kerning(1.1)
                .foregroundStyle(Palette.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    modelChip(id: nil, label: "Default")
                    ForEach(catalog, id: \.id) { choice in
                        modelChip(id: choice.id, label: choice.label)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func modelChip(id: String?, label: String) -> some View {
        let selected = model == id
        return Button {
            withAnimation(.easeOut(duration: 0.18)) { model = id }
        } label: {
            Text(label)
                .font(.system(size: 13, weight: selected ? .semibold : .regular))
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .foregroundStyle(selected ? Palette.signal : Palette.muted)
                .background(Capsule().fill(selected ? Palette.signal.opacity(0.16) : Palette.surface))
                .overlay(Capsule().stroke(Palette.line.opacity(selected ? 0 : 1), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var permissionPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PERMISSION MODE")
                .font(.system(size: 10, weight: .bold))
                .kerning(1.1)
                .foregroundStyle(Palette.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ManagedPermissionMode.allCases) { mode in
                        let selected = permission == mode
                        Button {
                            withAnimation(.easeOut(duration: 0.18)) { permission = mode }
                        } label: {
                            Text(mode.label)
                                .font(.system(size: 13, weight: selected ? .semibold : .regular))
                                .padding(.horizontal, 14)
                                .frame(height: 34)
                                .foregroundStyle(selected ? Palette.signal : Palette.muted)
                                .background(Capsule().fill(selected ? Palette.signal.opacity(0.16) : Palette.surface))
                                .overlay(Capsule().stroke(Palette.line.opacity(selected ? 0 : 1), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var startButton: some View {
        Button {
            Task { await start() }
        } label: {
            HStack(spacing: 8) {
                if working {
                    ProgressView().controlSize(.small).tint(Palette.ink)
                }
                Text("Start")
                    .font(.system(size: 16, weight: .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.signal)
        .foregroundStyle(Palette.ink)
        .disabled(project.trimmed.isEmpty || cwd.trimmed.isEmpty || working)
    }

    private func start() async {
        let trimmedProject = project.trimmed
        let trimmedCwd = cwd.trimmed
        guard !trimmedProject.isEmpty, !trimmedCwd.isEmpty else {
            validationError = "A project and a working directory are required."
            return
        }
        guard trimmedCwd.hasPrefix("/") else {
            validationError = "The working directory must be an absolute path."
            return
        }
        working = true
        validationError = nil
        failure = nil
        defer { working = false }
        do {
            _ = try await store.startManagedSession(
                cwd: trimmedCwd,
                project: trimmedProject,
                objective: objective.trimmed,
                prompt: prompt.trimmed,
                permissionMode: permission.wire,
                model: model
            )
            dismiss()
        } catch {
            failure = BridgeError.from(error)
        }
    }
}

/// A validation problem the caller can fix: amber, not red, because nothing has
/// been sent yet. Distinct from `FailureNote`, which is the bridge answering.
private struct ValidationNote: View {
    var message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 15))
                .foregroundStyle(Palette.amber)
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(Palette.text.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Palette.amber.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amber.opacity(0.24), lineWidth: 1))
    }
}

enum ManagedPermissionMode: String, CaseIterable, Identifiable {
    case `default` = "default"
    case acceptEdits = "acceptEdits"
    case plan = "plan"
    case auto = "auto"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .default: "Ask"
        case .acceptEdits: "Auto-edit"
        case .plan: "Plan"
        case .auto: "Auto"
        }
    }

    var wire: String { rawValue }
}
