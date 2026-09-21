# Agents catalog (CLI + app + `@happier-dev/agents`)

This doc explains how the **Agents catalog** works end-to-end in Happier, and how to add a new agent/provider.

The goal is that both surfaces:
- stay **catalog-driven** (no screen-level `if (agentId === ...)`),
- stay **capability-driven** (runtime checks come from daemon/CLI capability results),
- stay **explicit and reviewable** (no filesystem scanning, no side-effect self-registration),
- share a stable **AgentId contract** across packages.

---

## Key concepts (shared language)

- **AgentId**: canonical id for an agent across packages (CLI + app + server).
  - Source of truth: `@happier-dev/agents` (`packages/agents/src/manifest.ts`).
- **detectKey**: CLI executable name used for detection UX and `command -v <detectKey>`-style probes.
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].detectKey`).
- **cliSubcommand**: the primary CLI subcommand for this agent (usually the same as `AgentId`).
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].cliSubcommand`).
- **flavorAliases**: extra strings we accept for parsing/migration (e.g. `codex-acp`).
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].flavorAliases`).
- **Capabilities**: machine/runtime checks produced by the daemon (implemented by CLI) and consumed by the app.
  - Convention (CLI): `cli.<agentId>`, `tool.<name>`, `dep.<name>`.
- **Checklists**: higher-level groupings of capabilities that the app can render as guided setup steps.
  - Convention: `new-session`, `machine-details`, `resume.<agentId>`.

---

## What lives where (sources of truth)

### 1) Shared manifest + runtime metadata: `@happier-dev/agents`

Where:
- `packages/agents/src/manifest.ts`
- `packages/agents/src/localCli.ts`
- `packages/agents/src/auth.ts`
- `packages/agents/src/acp.ts`

What belongs here:
- canonical ids/types (`AgentId`, `AGENT_IDS`)
- CLI identity contract (`detectKey`, `cliSubcommand`, `flavorAliases`)
- local CLI UX metadata (`machineLoginKey`, login support, docs URL, login launch defaults)
- declarative auth probe metadata
- built-in generic ACP launcher/runtime metadata
- resume contract (`resume.vendorResume`, `resume.vendorResumeIdField`)
- cloud-connect mapping (when applicable): `cloudConnect`

What does **not** belong here:
- app-only visual assets (images/icons)
- app navigation/routes
- CLI implementation details (argv/env/paths)

### 2) Cross-boundary contracts: `@happier-dev/protocol`

Where:
- `packages/protocol/src/*`

What belongs here:
- daemon RPC request/result shapes the app must interpret deterministically
- stable error codes (spawn/resume failures, capability errors, etc.)

Example:
- `packages/protocol/src/spawnSession.ts` defines `SpawnSessionErrorCode` + `SpawnSessionResult`.

### 3) CLI agent catalog: `apps/cli/src/backends/catalog.ts`

This is the CLI’s explicit assembly of backends into a deterministic map:
- `export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = { ... }`
- helper resolvers such as `resolveCatalogAgentId(...)`

True provider-specific backend folders live under:
- `apps/cli/src/backends/<agentId>/**`

Generic ACP runtime/catalog machinery lives under:
- `apps/cli/src/agent/acp/**`
- `apps/cli/src/agent/acp/catalog/**`

That split is intentional:
- `apps/cli/src/backends/**` is for provider-owned implementations
- `apps/cli/src/agent/acp/**` is for provider-agnostic ACP plumbing
- built-in generic ACP agents such as Kiro are declared in `@happier-dev/agents` and consumed by the generic ACP layer

### 4) App agents catalog: `apps/ui/sources/agents/catalog/catalog.ts`

This is the app’s single public surface for screens:
- screens import from the `@/agents/catalog` entrypoint backed by `apps/ui/sources/agents/catalog/**`
- it composes:
  - **core registry** (`registry/registryCore.ts`) for identity + app config
  - **UI registry** (`registry/registryUi.ts`) for assets/visuals (lazy loaded for Node-safe tests)
  - **behavior registry** (`registry/registryUiBehavior.ts`) for provider-specific hooks

Provider code lives under:
- `apps/ui/sources/agents/providers/<agentId>/**`

---

## App registries (mental model)

There are three layers inside `apps/ui/sources/agents/`:

1) **Core registry** (`registry/registryCore.ts`)
   - identity + app-facing config (translations, settings gating, permissions, connected service UX, resume config, etc.)
   - consumes canonical ids from `@happier-dev/agents`

2) **UI registry** (`registry/registryUi.ts`)
   - app-only visuals (icons, tints, avatar overlay sizing, glyphs)
   - imported lazily by the catalog entrypoint so Node-side tests can import `@/agents/catalog` without loading native assets

3) **Behavior registry** (`registry/registryUiBehavior.ts`)
   - provider-specific hooks for:
     - experimental resume switches,
     - runtime resume gating/prefetch,
     - preflight checks/prefetch + issues,
     - spawn/resume payload extras,
     - spawn env var transforms,
     - new-session UI chips + options.

---

## Capabilities + checklists contract (CLI ↔ app)

### Capability id conventions (CLI)

Defined/used in the CLI capability system:
- `cli.<agentId>`: base “agent detected + login status + (optional) ACP capability surface” probe
- `tool.<name>`: tool capability (e.g. `tool.tmux`)
- `dep.<name>`: dependency capability (e.g. `dep.codex-acp`)

### Checklist id conventions

Checklist ids are treated as stable API between daemon and app:
- `new-session`
- `machine-details`
- `resume.<agentId>`

### ACP resume (static policy, runtime negotiation)

We do **not** launch an ACP subprocess merely to probe `loadSession` support in normal UI/CLI flows.

Instead:
- resume eligibility is driven by the selected backend's static agents-catalog `supportsLoadSession` declaration
- when a declared-capable backend is actually resumed, its ACP `initialize` response must also negotiate `agentCapabilities.loadSession`; a mismatch fails before `session/load`
- explicit “resume inactive session” is **fail-closed**: if `loadSession` fails, we surface the error instead of silently starting a fresh vendor session
- any ACP capability probing (e.g. `includeAcpCapabilities`) is reserved for opt-in diagnostics / e2e probes, not day-to-day UX

Kimi Code discovery is a development exception for executable identity: current Kimi Code and legacy Python `kimi-cli` share the command name and cannot be distinguished by version ordering. Its provider-owned discovery uses a no-auth `initialize` fingerprint (including close/delete/fork and SSE), honors explicit executable overrides, and refuses unknown or legacy launches. This does not create a second resume policy. Probe cache identity includes the effective process environment, hashed in memory to avoid retaining credentials in cache keys.

Built-in ACP `supportsModes: 'no'` disables mode projection and both mode mutation paths at the shared backend. Kimi uses that policy until authenticated live mode behavior is verified; model controls remain available.

### ACP session listing (resume-only candidates)

Agents whose ACP server advertises `session/list` expose their own sessions as **resume-only** candidates through the existing direct-sessions RPC family, using the generic `{ kind: 'acpSessionList', cwd? }` source instead of a provider-owned session store.

- Static policy: `isAcpSessionListingDeclared(agentId)` in `packages/agents/src/acp.ts` — true only when the manifest declares both `sessionCapabilities.sessionListing: 'supported'` and `sessionListingSource: 'acp'` (currently Auggie, Qwen, Kimi, Kilo, Devin, Copilot, and FX). Generic and provider-owned ACP catalog entries project that same declaration into `getDirectSessionProviderOps`; the UI default behavior adds the browse source under the same declaration. No shared code branches on agent ids.
- Runtime authority: `AcpBackend.listSessions` checks the negotiated `agentCapabilities.sessionCapabilities.list` from `initialize` and fails with `AcpSessionCapabilityNotNegotiatedError` before dispatching `session/list`; the daemon reports it as `provider_unavailable`.
- UI/daemon compatibility: before sending the new `{ kind: 'acpSessionList' }` source, the canonical UI machine-direct-sessions operation probes `daemon.directSessions.acpSessionList.capability.get`. A missing method on the released `cli-v0.2.12` daemon degrades only this browse source to `provider_unavailable`; the UI never sends that daemon a source its released schema rejects. The capability is explicitly `resumeOnly: true` and grants no adjacent direct-session operation.
- Candidates are opaque provider identifiers preserved byte-exactly after nonblank validation, plus title/cwd/updatedAt. They feed the new-session **resume** picker only. Transcript paging, activity, follow leases, linking and takeover are intentionally absent for this source (optional members on `DirectSessionProviderOps`), and `listDirectBrowseProviderIds()` excludes `resumeOnly` browse sources so the link/open browse list never offers them.
- `session/close` is dispatched at `AcpBackend.dispose()` for the active session when negotiated, so agents that own session resources beyond the local process release them. When the live handshake also negotiates `session/delete`, the resume picker advertises a provider-owned candidate action and dispatches exactly one generic delete request after destructive confirmation. Agents that omit the capability remain valid and see no delete action; deleting a persisted Happier session never deletes the provider-owned candidate.

### Dynamic model lists

Whether a provider's model list is resolved at runtime is one catalog fact:
`AGENT_MODEL_CONFIG.<agentId>.dynamicProbe` in `@happier-dev/agents`.

- `'static-only'` — the curated `staticModels` list is the whole truth. The app does not run the
  preflight models probe and ignores any `sessionModelsV1` the session publishes.
- `'auto'` (default when omitted) — the app runs the preflight models probe on the new-session
  screen **and** consumes the in-session `sessionModelsV1` list. Both readers share this one flag,
  so flipping it turns on both.

A provider that publishes `sessionModelsV1` from its runtime and is left on `'static-only'` has an
active producer with its consumer gated off — the published list is silently discarded. Flipping
that flag is a user-visible change: the app switches to the dynamic row builder, which carries less
per-model metadata than the static one, so audit what the dynamic path drops before flipping.

Dynamic providers whose runtime starts lazily (Pi starts its process on the first prompt) publish
`sessionModelsV1` only after that first prompt, so the in-session model picker would offer nothing
but the current model and freeform custom until then. To close that window, the new-session screen
seeds the server-persisted `sessionModelsV1` from the wizard's own preflight probe at spawn
(`sync.publishSessionModelsSeedToMetadata`, wired in `useCreateNewSession`). The seed is
deliberately seed-only: if the runtime has already published for this session, the write is a
no-op, and the runtime re-publish stays authoritative. It only applies to `dynamicProbe !==
'static-only'` agents with no curated static list, and to built-in-agents spawns (not ACP custom).

A provider with both surfaces needs **one owner** for the model list. Claude's is
`apps/cli/src/backends/claude/models/resolveClaudeModelCatalog.ts`: the preflight probe adapter and
the in-session `sessionModelsV1` publisher both read it, so the two pickers cannot disagree about
which models exist or which effort tiers they report. Its provider-owned cache identity is the
normalized endpoint, credential kind, and full SHA-256 credential hash. A warm cache entry avoids a
network request; a cold session start may fetch the catalog before publishing the resolved models.
For Claude, a successful account response is authoritative for membership and API capability/context
facts; curated rows only enrich matching ids and serve as the fallback before the first success. A
later failed refresh retains the bounded last successful account snapshot, serves it during the
failure cooldown, and retries discovery after that cooldown without replacing it on repeat failure.
Effort tiers are resolved once when the session mode is built and travel on the mode, so spawn-time
resolution and launch-option hashing see the same value and hashing stays pure.

Claude dynamic discovery is one canonical allow/deny decision at that catalog owner. The account
setting `claudeDynamicModelProbeEnabled` defaults to `true`; setting it to `false`, or setting
`HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED=0` in the CLI/daemon environment, returns the static
catalog before resolving any credential or reading the provider-owned cache. The environment value
is a local kill switch and cannot re-enable discovery after the account setting disables it.

Provider-owned probing:
- The CLI capability RPC resolves the selected backend profile once before any model, mode, or
  config-option probe. It uses the same profile environment and Saved Secret resolver as session
  startup, then layers any connected-service materialization on top. Provider adapters consume the
  resulting `processEnv`; they must not rebuild a competing profile environment from ambient state.
- Implement the probe in `apps/cli/src/backends/<provider>/preflight/**` and register it through
  `getPreflightSessionControlsProbeAdapter`. Type it as `PreflightSessionControlsProbeAdapter` —
  that is the shape the caller invokes, and its params carry `connectedServices` and
  `accountSettings`. Typing it as the narrower `PreflightModelsProbeAdapter` compiles but silently
  drops those inputs.
- Set `resolveModelsProbeVariant` on the catalog entry whenever the probe result depends on
  something other than the agent id — runtime flavor, auth method, or the bound connected account.
  The returned string partitions the probe cache; without it, results computed for one account or
  runtime mode are served to another. Codex uses this generic cache variant; Claude instead declares
  provider-owned caching and keys its catalog by the effective endpoint and credential identity.
- Fail closed to the static catalog. A probe that cannot authenticate returns `null` rather than
  probing with whatever credential happens to be in the daemon's environment.

## Adding a new agent/provider (end-to-end)

### Step 0 — pick the id contract (critical)

Choose a new canonical id (example): `myagent`.

Prefer:
- `AgentId === cliSubcommand === detectKey`

If you need variants, use `flavorAliases` (and keep canonical ids stable).

### Step 1 — add/extend the canonical manifest (`@happier-dev/agents`)

Edit:
- `packages/agents/src/manifest.ts`

Add/update:
- `id`, `cliSubcommand`, `detectKey`
- `flavorAliases` (if needed)
- `localCli.ts` metadata when the agent has a local CLI/auth surface
- `auth.ts` declarative probe metadata when the auth status can be described centrally
- `acp.ts` built-in ACP metadata when the built-in agent runs through generic ACP
- `resume.vendorResume` (`supported | unsupported | experimental`)
- `resume.vendorResumeIdField` (optional)
- `cloudConnect` (optional)

### Step 2 — choose between provider-specific backend code and generic ACP

If the agent needs provider-specific behavior, create:
- `apps/cli/src/backends/myagent/`

Common files (as needed):
- `cli/command.ts` (subcommand handler)
- `cli/detect.ts` (version/login probe spec)
- `cli/capability.ts` (override for `cli.myagent`, if needed)
- `daemon/spawnHooks.ts` (daemon wiring tweaks, if needed)
- `acp/backend.ts` (ACP backend, if applicable)
- `cloud/connect.ts` (cloud connect, if applicable)

If the built-in agent is generic ACP-backed, do not add a bespoke backend folder just to shell out to ACP.

Instead:
- add its built-in metadata in `@happier-dev/agents`
- let `apps/cli/src/agent/acp/catalog/**` instantiate it generically
- when provider-owned ACP behavior needs the live Happier session, expose it through the catalog entry's `getAcpRuntimeBackendOptionsResolver`; the generic catalog runner is the single place that resolves and passes those backend options. Do not branch on the agent id in the generic runner or create a second session-notification path.
- keep static ACP differences on the built-in ACP definition: model config-option application, permission-intent-to-agent-mode mapping, and whether Happier MCP descriptors are passed through the standard ACP request. A `null` permission mapping is an intentional no-op, not a fallback mode. When an agent ignores the standard ACP MCP field but has a native MCP config model, keep that wire fact as `drop` and use one provider-owned, process-scoped config adapter rather than disabling Happier tools or mutating the user's files.

Configured user-defined ACP backends/presets do not become `AgentId`s.
They live in:
- `packages/protocol/src/acpCatalog/*`
- account settings `acpCatalogSettingsV1`
- CLI generic ACP catalog loaders under `apps/cli/src/agent/acp/catalog/configured/**`

Tool normalization (if the agent emits tools):
- Ensure the CLI normalizes provider tool calls/results into canonical V2 tool shapes (so the app can render them).
- See: `docs/tool-normalization.md` (V2 schemas + normalization entrypoints + trace/fixtures workflow).

### Step 3 — export one catalog entry and wire it into the CLI catalog

For provider-specific agents, create:
- `apps/cli/src/backends/myagent/index.ts`

Pattern:

```ts
import { AGENTS_CORE } from '@happier-dev/agents';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.myagent.id,
  cliSubcommand: AGENTS_CORE.myagent.cliSubcommand,
  vendorResumeSupport: AGENTS_CORE.myagent.resume.vendorResume,
  getCliCommandHandler: async () => (await import('./cli/command')).handleMyAgentCliCommand,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  // other hooks as needed...
} satisfies AgentCatalogEntry;
```

Then edit:
- `apps/cli/src/backends/catalog.ts`

Add:

```ts
import { agent as myagent } from '@/backends/myagent';

export const AGENTS = {
  // ...
  myagent,
};
```

### Step 4 — add the app provider folder + registries

Create provider modules:
- `apps/ui/sources/agents/providers/<agentId>/core.ts`
- `apps/ui/sources/agents/providers/<agentId>/ui.ts`
- `apps/ui/sources/agents/providers/<agentId>/uiBehavior.ts` (optional; only if you need overrides)

Wire them into registries:
- add `*_CORE` to `apps/ui/sources/agents/registry/registryCore.ts`
- add `*_UI` to `apps/ui/sources/agents/registry/registryUi.ts`
- add `*_UI_BEHAVIOR_OVERRIDE` to `apps/ui/sources/agents/registry/registryUiBehavior.ts` (only if you have overrides)

### Step 5 — update `@happier-dev/protocol` only when the boundary truly changes

If you need new daemon/app fields, add them to:
- `packages/protocol/src/*`

Then update both sides (CLI implementation + app consumer) to match the new stable contract.

### Step 6 — verify (repo-local and happy-stacks)

Repo-local:

```bash
yarn typecheck
yarn test
```

Scoped:

```bash
yarn --cwd apps/cli typecheck
yarn --cwd apps/ui typecheck
```

If you’re running this repo via happy-stacks, prefer:
- `happys typecheck happy`
- `happys test happy`

---

## Node-safe imports (tests)

Some tests import the app agents catalog in a Node environment. Avoid importing native/icon modules from code that executes during those imports.

Patterns we use:
- the catalog entrypoint lazy-loads `registry/registryUi.ts` to avoid loading image files in Node.
- if a provider behavior needs a React Native component (e.g. action chips), lazy-require it inside the hook.

---

## Anti-patterns (please don’t)

- Don’t “auto-discover” backends by scanning the filesystem. We want deterministic bundling and explicit reviewable changes.
- Don’t do side-effect self-registration (“import this file and it registers itself”). It makes ordering brittle and behavior hard to audit.
- Don’t hardcode agent-specific logic in generic screens; add a typed hook in the provider’s `uiBehavior.ts` instead.
- Don’t import native assets from code that must run in Node tests (keep assets in `registry/registryUi.ts` and lazy-load).
