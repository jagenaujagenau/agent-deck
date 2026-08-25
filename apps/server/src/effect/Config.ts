import { Config } from "effect"

/**
 * Every runtime knob the bridge reads, in one place.
 *
 * The bridge is reachable over a tailnet and accepts remote instructions, so
 * these are read through `Config` rather than `process.env`: a test can supply
 * a different provider, and a missing required value fails at layer
 * construction instead of at the first request that needed it.
 */
export const BridgeConfig = Config.all({
  /** Where the SQLite file lives. Matches the path the existing bridge uses. */
  databaseUrl: Config.string("DATABASE_URL").pipe(
    Config.withDefault("file:../../local.db"),
    Config.map((url) => (url.startsWith("file:") ? url.slice(5) : url))
  ),
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  /** Names the bridge in the snapshot devices render. */
  name: Config.string("BRIDGE_NAME").pipe(Config.withDefault("Local bridge")),
  /**
   * The master runtime credential. Absent means unauthenticated local use;
   * `requireAuth` is what turns refusal on, so the two are read separately.
   */
  masterToken: Config.string("BRIDGE_TOKEN").pipe(Config.option),
  requireAuth: Config.boolean("BRIDGE_REQUIRE_AUTH").pipe(Config.withDefault(false))
})

export type BridgeConfig = typeof BridgeConfig extends Config.Config<infer A> ? A : never
