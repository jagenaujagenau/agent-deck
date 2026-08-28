import SwiftUI

@main
struct AgentDeckApp: App {
    @State private var store = DeckStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            DeckView()
                .environment(store)
                // Dark is not a preference here; it is the only world the deck
                // has been designed in.
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                store.start()
                Task { await store.refresh() }
            case .background:
                // iOS will tear the socket down anyway; dropping it deliberately
                // means the reconnect is ours to time rather than a surprise.
                store.stop()
            default:
                break
            }
        }
    }
}
