import SwiftUI

/// Which model this session answers as.
///
/// The list is the runtime's own — asked of it, never compiled into the app —
/// so a model that shipped this morning is here this morning, and a model this
/// account cannot reach is not here at all. Only a bridge-hosted session has
/// one: a session running in somebody's terminal answers as whatever that
/// terminal told it to, and the sheet says so rather than offering a control
/// that would do nothing. Mirrored from Android's `ModelPicker.kt`.
struct ModelPicker: View {
    var models: [RuntimeModel]
    var current: String
    var onPick: (RuntimeModel) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Model")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text(
                models.isEmpty
                    ? "This session's model belongs to the runtime running it."
                    : "What this session answers as, from the runtime's own list."
            )
            .font(.system(size: 13))
            .foregroundStyle(Palette.muted)
            .padding(.bottom, 9)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(models) { model in
                        // The running model is matched by id or by what an alias
                        // resolves to, so a session started on an explicit id
                        // still shows its alias row as the one it is on.
                        let selected = model.id == current || model.resolvedModel == current
                        Button {
                            onPick(model)
                        } label: {
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(model.label)
                                        .font(.system(size: 14, weight: selected ? .semibold : .regular))
                                        .foregroundStyle(selected ? Palette.signal : Palette.text)
                                        .lineLimit(1)
                                    if let description = model.description, !description.isEmpty {
                                        Text(description)
                                            .font(.system(size: 12))
                                            .foregroundStyle(Palette.muted)
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                    }
                                }
                                Spacer(minLength: 0)
                                if selected {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Palette.signal)
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(selected ? Palette.signal.opacity(0.10) : Palette.surface)
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.surface)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
