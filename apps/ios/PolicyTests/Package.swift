// swift-tools-version: 5.9
import PackageDescription

// The iOS app's pure policy layer, made testable without an Xcode test
// target: `Sources/AgentDeckPolicy` is a symlink to `apps/ios/AgentDeck/Model`,
// so `swift test` compiles and exercises the very files the app ships — the
// hand-mirrored Swift copies of the deck's shared rules, which until this
// package existed were the copies with no proof of parity.
let package = Package(
    name: "AgentDeckPolicy",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "AgentDeckPolicy", path: "Sources/AgentDeckPolicy"),
        .testTarget(
            name: "AgentDeckPolicyTests",
            dependencies: ["AgentDeckPolicy"],
            path: "Tests/AgentDeckPolicyTests"
        ),
    ]
)
