import SwiftUI

/// What was said before the runtime was ready to hear it, held where it can
/// still be taken back. Each row is one queued instruction: the pencil pulls
/// its words back into the composer (withdrawing the original), the cross
/// withdraws it outright. Once the runtime collects a message its row
/// disappears — a delivered instruction cannot be unsaid, only followed up.
struct QueuedMessageDock: View {
    var queued: [QueuedCommand]
    var onEdit: (QueuedCommand) -> Void
    var onCancel: (QueuedCommand) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(queued) { command in
                HStack(spacing: 8) {
                    Image(systemName: "clock")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted)
                    Text((command.value ?? "").isEmpty ? command.action : command.value ?? "")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.text.opacity(0.85))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Button { onEdit(command) } label: {
                        Image(systemName: "pencil")
                            .font(.system(size: 12))
                            .foregroundStyle(Palette.muted)
                            .frame(width: 28, height: 28)
                    }
                    .accessibilityLabel("Edit queued message")
                    Button { onCancel(command) } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11))
                            .foregroundStyle(Palette.muted)
                            .frame(width: 28, height: 28)
                    }
                    .accessibilityLabel("Cancel queued message")
                }
                .padding(.vertical, 2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 14).fill(Palette.surface))
        .frame(maxWidth: .infinity)
    }
}
