import SwiftUI

/// Where a bridge is named and a device is paired.
///
/// Doubles as the recovery screen: a refused credential and an absent bridge
/// both land here, but they arrive saying different things, because they are
/// fixed in different places.
struct ConnectView: View {
    @Environment(DeckStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var url: String = ""
    @State private var code: String = ""
    @State private var deviceName: String = ""
    @State private var working = false
    @State private var failure: BridgeError?
    @FocusState private var focus: Field?

    private enum Field { case url, code, name }

    private var credential: Credential { Credential.of(code.trimmed) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    fields
                    if let failure { FailureNote(failure: failure) }
                    connectButton
                    if store.connection.isConfigured { forgetButton }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.ink)
            .navigationTitle("Bridge")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.tint(Palette.muted)
                }
            }
            .toolbarBackground(Palette.ink, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .onAppear {
            url = store.connection.baseURL
            deviceName = store.connection.deviceName
            if url.isEmpty { focus = .url }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connect a bridge")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text("Use your machine's Tailscale IP or MagicDNS name, then enter the one-time code printed by the bridge.")
                .font(.system(size: 14))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var fields: some View {
        VStack(spacing: 12) {
            LabelledField(label: "Bridge address", hint: "A MagicDNS name is served over HTTPS; an address with a port is not. Type the scheme yourself to override.") {
                TextField("", text: $url, prompt: Text("bridge address").foregroundStyle(Palette.muted))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .url)
                    .submitLabel(.next)
                    .onSubmit { focus = .code }
            }
            LabelledField(label: "Pairing code or token", hint: codeHint) {
                TextField("", text: $code, prompt: Text("optional").foregroundStyle(Palette.muted))
                    // Not numberPad: this field also takes the bridge's own
                    // token, which a number pad cannot type.
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .code)
                    .onChange(of: code) { _, value in
                        // Codes get read aloud and typed with spaces in them.
                        code = value.filter { !$0.isWhitespace }
                        failure = nil
                    }
            }
            LabelledField(label: "Device name", hint: "How this phone appears in the bridge's paired devices.") {
                TextField("", text: $deviceName, prompt: Text(Connection.defaultDeviceName).foregroundStyle(Palette.muted))
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .name)
            }
        }
        .disabled(working)
    }

    private var codeHint: String {
        switch credential {
        case .none: "Leave blank to keep this device's stored token."
        case .pairingCode: "Six digits — this will pair the device."
        case .rawToken: "Not six digits, so this is used as the bridge's own token."
        }
    }

    private var connectButton: some View {
        Button {
            Task { await connect() }
        } label: {
            HStack(spacing: 8) {
                if working {
                    ProgressView().controlSize(.small).tint(Palette.ink)
                }
                Text(credential == .pairingCode ? "Pair & connect" : "Connect")
                    .font(.system(size: 16, weight: .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.signal)
        .foregroundStyle(Palette.ink)
        .disabled(url.trimmed.isEmpty || working)
    }

    private var forgetButton: some View {
        Button("Forget this bridge", role: .destructive) {
            store.disconnect()
            dismiss()
        }
        .font(.system(size: 14))
        .tint(Palette.danger)
        .frame(maxWidth: .infinity)
    }

    private func connect() async {
        working = true
        failure = nil
        defer { working = false }
        do {
            try await store.connect(baseURL: url, pairingCode: code, deviceName: deviceName)
            dismiss()
        } catch {
            failure = BridgeError.from(error)
        }
    }
}

/// Shared field chrome: a label, a bordered well, and a hint beneath. Reused by
/// the connect and start-session sheets so the form reads as one surface.
struct LabelledField<Content: View>: View {
    var label: String
    var hint: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .bold))
                .kerning(1.1)
                .foregroundStyle(Palette.muted)
            content
                .font(.system(size: 15))
                .foregroundStyle(Palette.text)
                .tint(Palette.signal)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(RoundedRectangle(cornerRadius: 14).fill(Palette.surfaceRaised))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
            Text(hint)
                .font(.system(size: 11))
                .foregroundStyle(Palette.muted.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A failure with its own remedy attached. The two failures that matter here
/// are answered in different places, and saying which is the whole job.
struct FailureNote: View {
    var failure: BridgeError

    private var tint: Color { failure == .unauthorized ? Palette.amber : Palette.danger }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: failure == .unauthorized ? "lock.trianglebadge.exclamationmark" : "wifi.slash")
                    .font(.system(size: 15))
                    .foregroundStyle(tint)
                Text(failure.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
            }
            Text(failure.localizedDescription)
                .font(.system(size: 12))
                .foregroundStyle(Palette.text.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)
            if let remedy = failure.remedy {
                Text(remedy)
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(tint.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(tint.opacity(0.24), lineWidth: 1))
    }
}
