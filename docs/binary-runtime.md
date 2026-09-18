# Binary-Safe Runtime and Bundled Workspaces

Happier ships binary installers. First-party runtime paths must work on machines that do not have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

## Runtime contract

Do not introduce direct product-runtime calls to:

- `spawn('node', ...)`
- `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- shell installers from UI/daemon/runtime code
- PATH-only provider detection as the sole source of truth

These are allowed only behind centralized managed runtime/tooling abstractions.

Before adding or changing a provider/runtime/install/update flow, classify it as one of:

- system-first backend CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS-runtime dependent

Provider detection, install status, daemon validation, runtime spawning, and UI/installables must reuse the same source of truth. Backend CLIs should prefer user/system installs by default over Happier-managed installs unless an explicit setting says otherwise.

## Desktop-initiated CLI acquisition

The desktop app acquires the Happier CLI itself; the user never runs an installer to connect the
computer the app is on. Acquisition is not a separate step: `runLocalHappierJsonCommand`
(`apps/bootstrap/src/systemTasks/happierCli.ts`) calls
`ensureLocalFirstPartyComponentCommand(...)` before every CLI invocation that does not already
carry a resolved CLI, so reading daemon status already downloads, verifies and installs the managed
CLI when it is missing. There is no second acquisition trigger, no cross-process lock, and no
persisted prefetch state — one in-memory promise per app open.

A task that runs several commands (or re-reads status while waiting for the daemon) resolves the
CLI once through `resolveVersionedLocalHappierCli(...)` and passes it to each command. That
resolver is also where a CLI and the version it reports for itself are established together, so
`daemon.service.status.v1` states which command answered, its provenance, and its version instead
of leaving acquisition an unstated side effect. `ensureSetupCapableLocalHappierCli(...)` is the
same resolver plus the setup version floor, and it stays on the setup path that mutates this
computer; the read-only inspection reports the version rather than refusing to answer.

Resolution order and provenance (`systemTasks/localFirstPartyCommand.ts`):

| Source | Provenance | Notes |
| --- | --- | --- |
| `HAPPIER_BOOTSTRAP_CLI_PATH` / `HAPPIER_BOOTSTRAP_HAPPIER_PATH` | `override` | Development only. |
| Installed managed payload for the caller's release ring | `managed` | The desktop-managed install layout recorded it. |
| Repo-local `apps/cli/bin/happier.mjs` | `override` | Accepted on path existence alone. |
| Nothing resolvable | — | Acquire through the managed path, then `managed`. |

The release ring comes from the caller (the app's variant), never a hardcoded default, so a
preview app acquires a preview CLI. `SETUP_CLI_VERSION_FLOOR` in `happierCli.ts` is the one
version floor desktop setup enforces; below it a managed CLI is reacquired once and then fails by
name, and an `override` CLI fails immediately. Only `managed` is approved for pairing silently; an
`override` CLI is put to the user once, naming the resolved path. `managed` records install
ownership, not verified publisher provenance — see
[Managed-CLI install ownership](cli-architecture.md#managed-cli-install-ownership-silent-vs-attended-approval).

## PATH exposure

`packages/cli-common/src/firstPartyRuntime/ensureHappierCliPathExposure.ts` is the sole owner of
making `happier` resolve in a new terminal after desktop setup. It is deliberately **not** part of
`installVersionedPayload`: that installs every first-party payload, while PATH exposure is
CLI-specific and must never block setup.

What it guarantees:

- **Byte-identical lines.** The POSIX export line and shell/rc-file selection are a transcription
  of `apps/website/public/install.sh`, so if the shell installer already wrote that exact line the
  desktop writes nothing. Deduplication is exact-line equality, and on Windows a case-insensitive
  entry comparison against the user `Path`.
- **Provenance, in both directions.** A Desktop-written POSIX line is preceded by
  `# Added by Happier Desktop`; on Windows the entries Desktop added are listed in the user
  environment variable `HAPPIER_DESKTOP_PATH_ENTRIES`. Removal
  (`removeHappierCliPathExposure`, exposed as the `cli.pathExposure.remove.v1` task and a settings
  action) strips only Desktop-created entries; a pre-existing installer-owned line is never
  marked, re-added, or deleted. Exposure writes the profiles of the shell the user runs today;
  removal scans every profile file in that same table (`.zshrc`, `.zprofile`, `.bashrc`,
  `.bash_profile`, `.profile`), so switching shells after setup cannot strand a marked line.
  Windows needs no equivalent: the user `Path` and `HAPPIER_DESKTOP_PATH_ENTRIES` live in
  `HKCU\Environment` and are shell-independent.
- **Never gating.** The setup executor starts PATH exposure alongside the remaining service work
  and never waits for it: the app begins its readiness proof from the task result, so a
  shell-profile write must not sit between setup and the reveal. A read-only profile therefore
  produces a settings repair action, not a failed setup and not a blocked reveal. The setup result
  carries no PATH field. What *is* observable of a failure: the run emits one
  `setup.thisComputer.pathExposure` progress event just before its result **if** the write has
  settled by then (the desktop bridge stops reading hsetup's stdout at the result line), and machine
  settings › Terminal reports the current state and repairs it through the `cli.pathExposure.*`
  tasks — the surface that owns it whether or not the run got to say anything.
- **`HAPPIER_NO_PATH_UPDATE=1` suppresses writes** (`changed: false`, no failure). It is read from
  the environment of the process that performs the write — the desktop app / `hsetup` — not from
  your shell rc files, so an `export` in `~/.zshrc` is invisible to an app launched from Finder,
  the Dock or a desktop launcher (macOS needs `launchctl setenv`, Linux `~/.profile` or
  `environment.d`; the Windows user environment works as expected). The reachable opt-out on every
  platform is the remove action in machine settings › Terminal. Removal is an explicit user action
  and is not suppressed by the variable.

Limits, stated so they are not assumed away:

- **There is no uninstall hook.** No desktop uninstall path exists in the Tauri/bootstrap shell,
  and dragging the app to the Trash cannot run app code, so PATH cleanup happens only when the
  user asks for it in machine settings.
- The installer's default POSIX `BIN_DIR` (`~/.local/bin`) differs from the Desktop-managed shim
  directory (`<happier home>/bin`). When both installers have run, two valid lines coexist:
  deduplication applies per directory, not per tool.
- **fish is not exposed.** `install.sh` routes every shell that is not bash or zsh to
  `~/.profile`, and the desktop transcribes that table verbatim (INV5), so a fish user gets a
  `~/.profile` line fish never reads and a reload hint that is not fish syntax. Changing this means
  changing `install.sh` first — it owns the policy — and the desktop following it; until then fish
  users invoke the CLI by path or add `<happier home>/bin` to `fish_user_paths` themselves.
- On Windows the two PowerShell helpers receive their inputs (the new `Path` value, its registry
  value kind, the provenance variable name and value) through the child process environment, read
  back as `$env:HAPPIER_PATH_*`. Nothing is passed as an argument after `-Command`: PowerShell
  folds later arguments into the command text it parses, and a `Path` value contains `;`.

## Internal workspace packages

Private workspace packages such as `packages/protocol`, `packages/agents`, `packages/cli-common`, and `packages/release-runtime` are not published independently, but they must ship inside published npm packages that import them at runtime.

Published hosts currently include:

- `apps/cli`
- `apps/stack`
- `packages/relay-server`

Their `prepack` scripts run `scripts/bundleWorkspaceDeps.mjs` to copy bundled workspaces into the host package and vendor each bundled workspace's external runtime dependency tree under that workspace's bundled `node_modules`.

## Dependency ownership

Add dependencies to the package that imports them:

- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- Do not mirror protocol-only dependencies into `apps/cli` merely because CLI bundles protocol.

Bundled workspaces are copied into the host package and are not installed by npm as independent workspace packages. The bundler vendors their external runtime dependencies based on each bundled workspace's own `package.json`.

## Internal dependency closure

`vendorBundledPackageRuntimeDependencies(...)` vendors external dependencies only. It intentionally ignores `@happier-dev/*`.

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency. For example, a host that bundles `@happier-dev/cli-common` may also need `@happier-dev/agents` and `@happier-dev/protocol` if they are in the runtime import closure.

## Adding a bundled internal workspace to CLI

When introducing a new `packages/<name>` that must ship with CLI:

1. Add it to `apps/cli/package.json#bundledDependencies`.
2. Add it to `apps/cli/package.json#dependencies` with workspace version `"0.0.0"`.
3. Add it to the `bundles` list in `apps/cli/scripts/bundleWorkspaceDeps.mjs`.
4. Update CLI bundling and published-dependency tests.

## Missing `dist` / invalid exports

Internal package `exports` point at `dist/**`. If `dist` is missing, consumers can fail with invalid-export errors.

Fix by building the workspace, for example:

```bash
yarn workspace @happier-dev/protocol build
```

Stack builds should fail fast or build missing internal workspace outputs through the stack build helpers.

## Bundling sanity checks

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive; release automation owns the archive it publishes.
