import Foundation

/// Sessions the person has put away.
///
/// Mirrored from `apps/android/mobile/.../ArchivePolicy.kt`. Archiving is a
/// device decision, not a bridge one: the runtime is still running and every
/// other surface should still see it. So this lives in `UserDefaults` and never
/// leaves the phone.
enum ArchivePolicy {
    private static let key = "archived_agents"

    /// The id alone. Older builds keyed on `id:something`; a stored key is
    /// normalised on read so an upgrade does not resurrect what was put away.
    static func archiveKey(_ agent: Agent) -> String { agent.id }

    static func normalize(_ keys: Set<String>) -> Set<String> {
        Set(keys.map { String($0.prefix(while: { $0 != ":" })) })
    }

    static func load(from defaults: UserDefaults = .standard) -> Set<String> {
        normalize(Set(defaults.stringArray(forKey: key) ?? []))
    }

    static func save(_ keys: Set<String>, to defaults: UserDefaults = .standard) {
        defaults.set(Array(keys), forKey: key)
    }

    static func unarchived(_ agents: [Agent], archived: Set<String>) -> [Agent] {
        agents.filter { !archived.contains(archiveKey($0)) }
    }
}
