import pkg from "../../package.json" with { type: "json" };

/**
 * The bridge's version, read from the package that defines it.
 *
 * Read rather than restated so the two cannot disagree: a hand-copied constant
 * is only correct until the first release that forgets it, and a version the
 * desktop app displays is worth less than nothing when it is quietly stale.
 */
export const BRIDGE_VERSION: string = pkg.version;
