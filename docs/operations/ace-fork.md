# Ace's editable desktop fork

The primary checkout is `~/T3CodeFork`, on `main`. The installed app is
`/Applications/T3 Code (Ace).app`. Its UI, T3 home, browser profile, provider
configuration, and login identity match Nightly. Quit Nightly before opening Ace;
the two applications use the same profile and are intended to run one at a time.

## Editing

For a separate desktop preview while the installed app stays open:

```sh
python3 ForkTools/Preview.py
```

The preview opens as `T3 Code (Dev)` and keeps its test threads under
`~/Library/Application Support/T3CodeFork/Preview`. It uses Electron's separate
development profile. The launcher builds an optimized renderer before opening
the window, so navigation does not wait for development compilation. Relaunch
after source edits to rebuild. Quitting the preview also stops its renderer server.
Keep its terminal open; Ctrl+C also stops the preview processes.

To seed history before the first launch, run `python3 ForkTools/PreviewHistory.py`.
It takes a consistent read-only snapshot, disconnects provider sessions, clears
pending work, and redirects projects to empty preview folders. History changes
never sync back. Project settings and live provider sessions are not copied.
The snapshot command refuses to overwrite an existing preview database.

On its first launch, the preview imports Codex and Claude provider entries from
Nightly's settings and uses their existing CLI logins. Existing preview entries
win, and later launches preserve account changes made in the preview. Credentials
are not copied; instances with environment overrides need separate setup in
**Settings > Providers**.

Experimental visuals must use `AcePreviewEnabled` or the `data-ace-preview`
document attribute. Vite enables them for development previews and the explicit
`ace-preview` build mode. Compiled preview assets live in the preview home's
`Renderer` directory; ordinary builds keep the experimental UI disabled.

For edits that reload as you save, use `python3 ForkTools/Preview.py --dev`.
That mode uses production React but still runs the development asset server.
For React development diagnostics and Fast Refresh, use
`T3CODE_ACE_DEBUG_RENDERER=1 python3 ForkTools/Preview.py --dev`.

Commit and push changes on `main`, then prepare a local build:

```sh
python3 ForkTools/Updater.py build
```

The existing update controls offer the validated build. It also installs after
you quit Ace normally. For the first installation, or when Ace is already closed:

```sh
python3 ForkTools/Updater.py install
open '/Applications/T3 Code (Ace).app'
```

## Nightly updates

The existing startup, periodic, and manual update checks run the bundled fork
updater. It follows published macOS Nightly releases, checks the Git merge,
builds a source archive in a temporary directory, runs targeted updater tests,
typechecks desktop and web, and launches the packaged app with an isolated profile
and a mock Keychain. Startup validation has a two-minute host timeout.
Only after those checks pass does it advance and push the primary `main` and
offer the app for installation. No Git branches or worktrees are used for builds.

Uncommitted edits pause updates. Conflicts and failed builds leave your checkout
and installed app unchanged. A failed push retains the validated candidate for
retry. Updates never restart active work automatically; installation waits for
you to quit or choose the existing restart action.

A failed build pauses repeated attempts for the same source, Nightly, and build
configuration. Fixing and committing the source or receiving a newer Nightly
allows another attempt. To retry unchanged inputs after a transient failure:

```sh
python3 ForkTools/Updater.py prepare --retry
```

The app's update check continues to show the failure until those inputs change
or you run that retry command. The local `build` command also retries explicitly.

Preparing a new release runs a local build, so it uses CPU and disk for several
minutes. Quitting during preparation cancels that build; the next check retries.

When a conflict is reported, use your agent in the installed app to resolve it
in `~/T3CodeFork`. The report gives the exact upstream tag. Merge that tag on
`main`, resolve and commit the conflict, push, then run the build command above.

Configuration, pending builds, and logs live at the paths in
`~/Library/Application Support/T3CodeFork/Config.json`. No credentials or thread
data are committed. Before installation, the updater snapshots the thread
database and settings under its cache `Backups` directory and retains the prior
application as `PreviousBundle`. Restoring an older application after a database
migration may also require restoring its matching database snapshot.

`PublicBuildEnvironment` in that configuration must include the four public
`T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T3CODE_RELAY_URL` values from the official
`.env.example`. Builds refuse to proceed without them so login and T3 Connect
are not silently omitted. These are public build settings, not account tokens.

The app uses a local installer because this Mac has no release signing identity.
It never downloads official binaries over your custom app. macOS may ask you to
allow the locally built application access to its existing Keychain entry.
That permission can be requested again after installing a newly built version;
background validation copies never need access to the real Keychain.
