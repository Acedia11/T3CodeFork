# Ace's editable desktop fork

The primary checkout is `~/T3CodeFork`, on `main`. The installed app is
`/Applications/T3 Code (Ace).app`. Its UI, T3 home, browser profile, provider
configuration, and login identity match Nightly. Quit Nightly before opening Ace;
the two applications use the same profile and are intended to run one at a time.

## Editing

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
typechecks desktop and web, and launches the packaged app with an isolated profile.
Only after those checks pass does it advance and push the primary `main` and
offer the app for installation. No Git branches or worktrees are used for builds.

Uncommitted edits pause updates. Conflicts and failed builds leave your checkout
and installed app unchanged. A failed push retains the validated candidate for
retry. Updates never restart active work automatically; installation waits for
you to quit or choose the existing restart action.

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
