import SwiftUI

/// The train of thought, where the provider chose to share one.
///
/// The banner is not decoration: an empty reasoning tab is ambiguous between
/// "it is not thinking" and "this model does not expose what it thinks", and
/// only the second is ever true here.
struct ReasoningView: View {
    var events: [AgentEvent]

    /// A drag says "I am reading this". Nothing else takes the view off the
    /// newest thought.
    @State private var followingTail = true
    @State private var newReasoningWaiting = false

    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                banner
                if events.isEmpty {
                    empty
                } else {
                    list(proxy)
                }
            }
            // Keyed on the newest event, not the count: history is fetched with
            // a cap, so on a long-running session the count sits pinned at that
            // cap while the contents roll underneath it — and a view watching
            // the count would never learn anything arrived again.
            .onChange(of: events.last?.id) { _, _ in
                if followingTail {
                    scrollToEnd(proxy)
                    newReasoningWaiting = false
                } else {
                    newReasoningWaiting = true
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.ink)
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        guard let last = events.last?.id else { return }
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
        }
    }

    private var banner: some View {
        HStack(spacing: 9) {
            Image(systemName: "eye")
                .font(.system(size: 14))
                .foregroundStyle(Palette.blue)
            Text("Only reasoning explicitly shared by the provider is shown.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Palette.blue.opacity(0.08))
    }

    private func list(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(events) { event in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Image(systemName: "brain")
                                .font(.system(size: 14))
                                .foregroundStyle(Palette.blue)
                            // A trailing ellipsis is the runtime saying the
                            // thought is still being had.
                            Text(event.summary.hasSuffix("\u{2026}") ? "Thinking" : "Reasoning")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Palette.blue)
                            Spacer(minLength: 0)
                            Text(messageClock(event.createdAt))
                                .font(.system(size: 10))
                                .foregroundStyle(Palette.muted.opacity(0.72))
                        }
                        Text(event.detail ?? "")
                            .font(.system(size: 14))
                            .lineSpacing(4)
                            .foregroundStyle(Palette.text.opacity(0.9))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Palette.surfaceRaised))
                    .id(event.id)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 18)
        }
        .defaultScrollAnchor(.bottom)
        .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in followingTail = false })
        .overlay(alignment: .bottom) {
            if newReasoningWaiting {
                Button {
                    followingTail = true
                    newReasoningWaiting = false
                    scrollToEnd(proxy)
                } label: {
                    Label("New reasoning", systemImage: "arrow.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 40)
                        .background(Capsule().fill(Palette.blue))
                }
                .buttonStyle(.plain)
                .padding(.bottom, 12)
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "brain")
                .font(.system(size: 26))
                .foregroundStyle(Palette.muted)
            Text("No shared reasoning")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text("This model has not exposed reasoning for this session.")
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 24)
    }
}
