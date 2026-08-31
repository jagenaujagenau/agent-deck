import SwiftUI

/// The conversation's table of contents: one row per exchange — what was
/// asked, how it ended — each a jump into the timeline. A two-hundred-turn
/// chat has no scrollbar worth the name; this is the one it earns.
struct ConversationMapSheet: View {
    var markers: [ConversationMarker]
    var onPick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Conversation")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.text)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(markers) { marker in
                        Button {
                            onPick(marker.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(marker.prompt)
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Palette.text)
                                        .lineLimit(1)
                                    Spacer(minLength: 8)
                                    Text(Timestamps.freshness(marker.at))
                                        .font(.system(size: 11))
                                        .foregroundStyle(Palette.muted)
                                }
                                if let reply = marker.reply {
                                    Text(reply)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Palette.muted)
                                        .lineLimit(1)
                                }
                            }
                            .padding(.horizontal, 6)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
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
