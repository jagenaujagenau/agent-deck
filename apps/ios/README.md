# Agent Deck for iOS

A SwiftUI phone surface for the bridge. iOS 17+, no third-party dependencies —
`URLSession` and `Codable` and nothing else.

```bash
open apps/ios/AgentDeck.xcodeproj
```

Building from the command line, which is what this was verified with:

```bash
xcodebuild -project apps/ios/AgentDeck.xcodeproj -target AgentDeck \
  -sdk iphonesimulator -arch arm64 -configuration Debug build
```

`-target` rather than `-scheme` on purpose: on a machine whose installed
simulator runtime is older than its iOS SDK, scheme-based destination
resolution intermittently reports every destination ineligible and refuses to
build. The target path does not consult destinations and is stable.

## What it does

| | |
| --- | --- |
| **Connect** | A bridge address and an optional pairing code. The token lives in the Keychain, keyed by the address it was issued for, so pointing the app at a second bridge does not carry the first one's credential to it. |
| **Deck** | Every session, grouped by what it wants — approvals, questions, input, failures, running, paused, recently completed — and by project inside each. Filters: Now / Needs you / History. |
| **Session** | The conversation, the pending approval with Approve and Reject, and a question with the runtime's own preset options. A composer where the runtime advertises `steer`, `prompt` or `follow_up`. |
| **Live** | SSE. |
| **Subagents** | A session that farms work out to agents of its own can be read one subagent at a time. The lens narrows the conversation to that subagent's events, including the message it leaves when it finishes. The composer stays, and its placeholder says the message goes to the session — a subagent has no inbox, but hiding the field said "you cannot reply", which is not true of the session. |
| **Reasoning** | What the provider chose to share, and a banner saying that is the only thing shown — an empty tab otherwise reads as "it is not thinking" rather than "this model does not expose what it thinks". |
| **Changes** | The session's file diffs from `/agents/:id/changes`, per file, with real line numbers where the runtime emits a unified diff and no gutter where it emits bare `-`/`+` pairs. |
| **Terminal** | The shell on the other end, drawn as a window: scrollback, a powerline status line, and a flat prompt that sends a command as an instruction to the runtime's shell tool. |
| **Usage** | `/bridge/v1/analytics` — spend, tokens, rate-limit rings, an activity heatmap and a token trend, filtered by window and project. |
| **Notifications** | A local notification per approval or question, with Approve and Reject on the banner. Limits below. |
| **Archive** | Swipe a card left to put a session away. A device decision: the runtime goes on running and the bridge is never told. History is where an archived session is read and restored. |

`agentdeck://agent/<id>` opens a session directly, the same link the Android app
answers, so a notification can land on the session it is about.

## Decisions

**The SSE parser reads bytes, not lines.** `URLSession.AsyncBytes.lines`
silently drops empty lines — and the blank line between records is the *only*
thing that ends an SSE event. Parsed through it, every record ran into the next
and nothing was ever dispatched: the deck showed whatever `/snapshot` last
returned, no live update ever reached it, and the connection sat there looking
healthy the whole time. It is parsed a byte at a time now, splitting on `\n`
and keeping the blank lines.

**A session tab refetches history on a timer, not on a count.** Live events
merge over the fetched history, and the snapshot's per-agent window is about two
dozen events — so a busy session loses a command a minute without a refetch. It
polls every twenty seconds and only spends the fetch when the live window
actually moved, which is what keeps an idle session from refetching at all.
The views watch the newest event's id rather than the event count, because the
history fetch is capped and on a long session that count sits pinned at the cap
while the contents roll underneath it.

**Commands type at a rate, not over a duration.** A one-word command and a
paragraph of shell should read as the same terminal working. Only lines that
arrive while the tab is open are typed; everything present when it opened is
scrollback and draws whole, keyed on event identity so a line is not re-typed
each time it scrolls back into view. Four speeds, and OFF means no animation
rather than a fast one. The control is a segment of the status line, because a
terminal keeps its settings there rather than behind a menu.

**The powerline chevrons are shapes.** U+E0B0 exists only in patched fonts and
renders as a hollow box everywhere else. The prompt's blinking caret only stands
in while the field is unfocused — once focused the text field draws a real one,
and two cursors on a prompt is worse than none.

**Amber stays reserved.** On the Usage screen cost is plain text and tokens are
blue; the only amber is a rate-limit ring past 70%, which genuinely is a session
about to stop and want a person. A bill is not a request.

**SSE, not polling.** `/bridge/v1/events` sends one full snapshot per connection
and then only the agents whose rendered state actually changed. Polling
`/bridge/v1/snapshot` on a timer would cost more and still show an approval up
to one interval late, which is the opposite of what a glanceable surface is for.
`URLSession.bytes(for:)` streams the body incrementally, so no client library is
needed. `/snapshot` is still used for the first paint, for pull-to-refresh, and
after any control command.

**401 is not "offline".** `BridgeError` separates a refused credential from an
address nothing answers at, and each carries its own remedy line. They are fixed
in different places, and one message for both sends people to the wrong one.
A refused credential also stops the reconnect loop outright — waiting has never
once fixed a token the bridge does not recognise.

**Absent is not wrong.** Swift's synthesized `Decodable` throws on a missing key
even where the property has a default, and the bridge legitimately omits
`options`, `capabilities`, `events`, `rateLimits` and more. Every wire type
reads its optional-on-the-wire fields through a tolerant helper instead. This
was not theoretical: the first build against a real bridge failed on an event
with no `options`.

**Subagent attribution is derived, not stored.** The bridge keeps no subagent
record, only events carrying the id and type of whichever subagent made them.
`subagentRuns` folds those into runs; `eventsOfSubagent` narrows the session to
one. Nothing has to be kept in sync with a second source of truth, and the same
conversation view renders a lens without a second screen existing.

**The harness marks are the Android drawables.** `HarnessArt.swift` is generated
from `apps/android/shared/src/main/res/drawable/harness_*.xml` and drawn by a
small SVG path reader in `SVGPath.swift`. One copy of the artwork in the
repository; redrawing it by hand would be a second drawing that drifts. Pi and
unknown runtimes have no vendor mark and fall back to a monogram, exactly as
`Harness.kt` does.

**Building needs a simulator runtime matching the SDK.** Xcode 26 renders app
icons through a simulator runtime, so `actool` refuses to compile the asset
catalog without one — on a device archive too, not just for the simulator:

```
error: No simulator runtime version from ["23A8464"] available to use with
       iphonesimulator SDK version 23E237
```

`xcodebuild -downloadPlatform iOS` fixes it. It is about 8.5 GB.

## Layout

```
AgentDeck/
  AgentDeckApp.swift     Scene, scene-phase stream lifecycle
  Assets.xcassets/       The app icon, and nothing else
  Model/                 The wire types and the shared policies, mirrored from
                         apps/android/shared: BridgeModels, Harness,
                         AgentActivity, HomePolicy, Conversation, Subagents,
                         ConnectionPolicy, Timestamps, AgentDiff,
                         TerminalPolicy, Analytics, ArchivePolicy,
                         AttentionPolicy
  Net/                   BridgeClient (endpoints + SSE), BridgeError, Keychain
  Store/                 DeckStore (the one place state is decided), Connection
  Notify/                ApprovalNotifier — local notifications, actionable
  UI/                    Theme, DeckView, AgentCard, SessionView, PendingCards,
                         ConnectView, HarnessMark, SVGPath, HarnessArt,
                         ReasoningView, DiffView, TerminalView, TerminalChrome,
                         UsageView
Support/
  Info.plist             ATS exception for the tailnet, URL scheme
  ExportOptions.plist    App Store Connect export
  testflight.sh          Archive, export, upload
  asc-preflight.ts       Proves the key, role and app record before that
  signing-bootstrap.ts   Fallback signing setup for a non-Admin key
```

The policies in `Model/` are ports of the Android shared module rather than new
decisions. Where the two disagree the Android one is right, because the watch
reads from it too.

## Not done

- **Approve, reject and answer are unverified end to end.** The code posts to
  `/agents/:id/control` and `/agents/:id/requests/:id/resolve`, but a bridge that
  publishes `pendingApproval` in its heartbeat without opening a durable request
  answers 409 and 404 to both — from any client, not just this one. They need a
  real runtime session to prove.
- **Notifications only fire while the app is running.** iOS suspends a
  backgrounded app and tears its socket down, so an approval that opens while the
  phone is in a pocket is not announced until the app is next opened. The
  notification itself is real — it carries Approve and Reject, answers from the
  lock screen, and opens the session it is about — but the delivery guarantee is
  not. Doing that properly needs APNs, which needs the bridge to store device
  tokens and send pushes: server work this app cannot do alone. A background
  refresh task would narrow the gap and not close it, so it is deliberately not
  here; a notification that arrives on iOS's schedule rather than the
  approval's would be worse than one that is honestly best-effort.
- **The slash command picker is unexercised.** The endpoint, the query parsing
  and the ranking are ported and the empty case is verified against a bridge that
  advertises none. No runtime on hand publishes a catalog, so the populated list
  has been compiled and not seen.
- **The terminal renders the newest 120 commands.** A lazy stack asked to hold
  nine hundred rows makes every jump to the bottom an estimate across hundreds of
  unrealised ones, and lands in blank space below its own content. Older
  scrollback is fetched and counted but not drawn.
- **No widget, no watch app, no wear relay.** Android has all three.

## Releasing to TestFlight

```bash
export ASC_KEY_ID=...        # the key's 10-character id
export ASC_ISSUER_ID=...     # the issuer uuid, shown once above the Keys list
export ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
apps/ios/Support/testflight.sh
```

Archives, exports and uploads. The build number defaults to a UTC timestamp,
because App Store Connect rejects a build number it has already seen and a
forgotten manual bump is the usual way a release stalls.

An App Store Connect API key rather than a signed-in Xcode: it can be revoked
on its own, works unattended, and covers everything the release needs.

**The key must have the Admin role.** Signing is cloud-managed — Xcode asks App
Store Connect for the distribution certificate and profile at export time, and
neither is stored on the machine that builds. The account only issues those
certificates to an Admin key. An App Manager key is refused with "You haven't
been given access to cloud-managed distribution certificates", and the export
then fails claiming `No profiles for 'nerdev.com.AgentDeck' were found`, which
sends you looking in entirely the wrong place. The message worth remembering is
the first one; it only appears in the `.xcdistributionlogs` bundle the export
leaves in `$TMPDIR`.

Nothing local means nothing to expire unnoticed, nothing to copy to a second
machine, and nothing to lose with a keychain. `Support/signing-bootstrap.ts` is
the fallback for an account that cannot grant Admin: it mints an ordinary
distribution certificate through the API, imports it into the login keychain and
builds a matching profile, and `ExportOptions.plist` then needs `signingStyle`
set to `manual`. Prefer the Admin key.

`Support/asc-preflight.ts` runs first and answers three questions in about a
second: is the key accepted, does the app record exist, and does the key have a
role that can create certificates. It never prints or transmits the key — the
private half only signs a short-lived token locally.

Prerequisites, once each:

- A simulator runtime matching the Xcode SDK, for the reason above.
- An App Store Connect API key with the **Admin** role
  (Users and Access → Integrations → Keys).
- A registered bundle id — `signing-bootstrap.ts` registers it.
- An app record for that bundle id. This one is unavoidable by hand: the API
  answers `The resource 'apps' does not allow 'CREATE'`, so it is made in App
  Store Connect under My Apps.
