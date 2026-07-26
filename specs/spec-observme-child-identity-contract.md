# ObservMe child identity contract tasks

## Objective

Add a versioned, explicit contract for a child agent's display name, role, and capability at the `startSubagent()` boundary. The launcher knows this metadata before process creation; ObservMe must not infer it from a command, child ID, inherited parent metadata, or a later child session.

This plan covers the public `@senad-d/observme/integration` API, runtime validation, process propagation, parent-side tree state, child-side lineage, telemetry, the transport-neutral runner, documentation, and contract tests. It also defines a package-decoupled interoperability profile for OrcMe, whose Pi package negotiates over `pi.events` without importing ObservMe from a shared module root.

## Current gap

`ObservMeStartSubagentOptions` currently accepts lifecycle and launch fields but no child metadata. The parent therefore creates a synthetic child with `role: "subagent"` and copies the parent's capability. `createPropagationEnvironment()` also propagates the parent's capability. There is no display-name field or child-identity envelope version. Launchers cannot state the intended child identity, parent-side views can mislabel a child, and child telemetry can inherit a capability that describes the parent.

The reviewed OrcMe consumer currently mirrors ObservMe API v1 in `src/process/observme.ts`, negotiates with `supportedVersions: [1]`, launches direct Pi RPC children with `--no-extensions`, preserves ObservMe's returned environment through a tombstone bridge, and intentionally declares no ObservMe dependency. Its current ObservMe documentation therefore describes API v1 as implemented behavior.

OrcMe's approved role-chain documentation separately defines a planned four-role contract: exactly `lead`, `helper`, `worker`, and `validator`. It treats definition name as bounded capability metadata, keeps role separate from authority, and states that ObservMe is supplementary evidence that must never infer or widen an OrcMe role. The docs do not claim that OrcMe already sends a v2 child descriptor or that a managed display-name field is already shipped. This plan must preserve that implemented-versus-planned distinction: ObservMe publishes the neutral v2 contract and fixture first; OrcMe adoption remains a downstream change after its durable display identity and role rollout are ready.

## Normative contract

The implementation tasks below must preserve these decisions:

- Integration API v2 adds one required `child` descriptor to `startSubagent()`:

  ```ts
  const OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION = 1 as const;
  const OBSERVME_CHILD_ROLES = ["lead", "helper", "worker", "validator"] as const;

  type ObservMeChildRole = (typeof OBSERVME_CHILD_ROLES)[number];

  interface ObservMeChildDescriptor {
    readonly displayName: string;
    readonly role: ObservMeChildRole;
    readonly capability: string;
  }
  ```

- API v2 exposes its exact frozen `childRoles` catalog and `childIdentityEnvelopeVersion` as runtime-readable fields. Package-decoupled consumers validate those fields structurally; they do not rely on `instanceof`, constructor identity, or shared Node module state.
- The package helper is a convenience, not a prerequisite. The stable `pi.events` channel, request shape, response-selection rules, v2 API shape, and lifecycle result unions are a documented wire contract that another Pi package may mirror locally.
- `displayName` is a human-readable presentation label. It is not an agent ID, must not participate in lifecycle correlation or authorization, and must never become a metric label.
- `role` is exactly one of `lead`, `helper`, `worker`, or `validator` in API v2. One exported readonly role catalog is the source for the public type, runtime validation, docs, and tests.
- The v2 role catalog is versioned rather than permanently fixed. Adding, changing, or removing a role requires a later integration API version so exhaustive v2 clients cannot silently receive a value they do not understand. Runtime-configurable role catalogs are not part of v2.
- A role is descriptive telemetry, not control authority. ObservMe does not infer role from definition name, depth, tools, claims, or prompts and does not grant or widen launcher permissions.
- `capability` is a stable launcher-defined machine value. It remains a trace, log, resource, and UI attribute and must not become a metric label unless a separate bounded allowlist contract is introduced.
- Runtime validation rejects empty, control-containing, invalid-Unicode, or oversized metadata before creating spans, tree nodes, metrics, logs, or propagation state. Validation does not silently trim, normalize, or rewrite caller values.
- Use a shared maximum of 128 Unicode code points for `displayName` and 64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*` for `capability`.
- Parent spawn telemetry records child metadata under unambiguous child-specific attributes. Child process telemetry records the same values as its own agent metadata.
- Child metadata supplied for a spawn replaces stale inherited metadata. The parent's role, capability, and display name must not be copied into the child's descriptor.
- The propagation envelope adds a version marker plus configurable role and display-name environment keys and reuses the existing capability key. All child-identity keys are scrubbed from the base environment before the selected child's values are written. Unknown future envelope versions fail open with one bounded, value-free propagation diagnostic instead of being partially interpreted.
- `root` remains an ObservMe runtime topology role, not a valid v2 child descriptor. Internal lineage code must distinguish the v2 child-role catalog from `root` and explicitly retained v1 or historical role values.
- OrcMe managed depth and ObservMe lineage depth are separate domains. An OrcMe `lead` is depth 0 in OrcMe's managed graph but may still be a child of the interactive root Pi process in ObservMe lineage. ObservMe must not infer either depth from the role.
- API v1 remains negotiable with legacy metadata-free behavior: the parent-side synthetic child and child runtime retain legacy `subagent` behavior, display name and child capability remain absent, and the parent's capability is no longer inherited. A v1 launch does not emit the v2 child-identity marker or fields, so an older separately loaded child extension remains compatible.
- Existing exported v1 names remain source-compatible: `OBSERVME_INTEGRATION_VERSION`, the current unsuffixed v1 API and type aliases, and `requestObservMeIntegration()` continue to mean v1. V2 uses explicit suffixed exports and `requestObservMeIntegrationV2()`; callers cannot accidentally receive a stricter API after only updating the package.
- V2-capable clients advertise `[2, 1]`. Each provider responds with its highest mutually supported version. The requester collects structurally valid synchronous responses until `emit()` returns, selects the highest version across providers, uses first response in Pi load order only as a same-version tie-breaker, and ignores late responses. `requestObservMeIntegrationV2()` returns only a selected v2 API; a v1-only result means v2 is unavailable.
- Negotiating a root provider proves only the in-process API. A launcher that explicitly loads a child ObservMe extension under `--no-extensions` must independently pin a child package release that understands child-identity envelope version 1. ObservMe publishes the minimum compatible release and a packed parent/child smoke contract.
- The downstream OrcMe mapping is exact once OrcMe adopts v2: durable managed display identity to `displayName`, manifest role to `role`, and pinned definition name to `capability`. Technical spawn, task, attempt, instance, and child-agent placeholders remain lifecycle identifiers and are never replaced by display metadata.
- OrcMe's documented policy remains explicit: `disabled` performs no negotiation; `inherit` follows effective OrcMe configuration; after v2 adoption, `enabled` requires a v2 root provider and a pinned envelope-compatible child extension. Export failure after a valid launch remains fail-open and never replaces OrcMe's durable task state.
- OrcMe's launch ordering remains intact: build and sanitize its managed base environment, pass it to `startSubagent()`, preserve every returned ObservMe value, and use explicit `undefined` tombstones so Pi RPC cannot restore keys ObservMe removed when it overlays `process.env`. Complete environments or unrelated values are never logged, persisted, hashed, displayed, or snapshotted.
- OrcMe keeps `spawnType: "extension"` and `spawnReason: "delegated_task"`. On duplicate requested `spawnId` or `childAgentId`, a consumer may retry once without those technical identifiers but must resend the identical child descriptor.
- Existing lifecycle ordering remains unchanged: launch failure calls `failSubagent()` once; actual blocking is wrapped by wait calls; completion is reported exactly once; and terminal evidence collection is wrapped by join calls.
- Display names, capabilities, command values, prompts, tasks, and environment contents remain untrusted telemetry input and must follow existing sanitization and content-safety boundaries.

## Tasks

IMPORTANT: Execute tasks in order and mark an item with `[x]` only after all of its acceptance criteria are met. Each task is intended to fit one focused implementation session; do not pull later-task work into an earlier task.

### 1. Define the source-compatible v2 public types

- [x] Add explicit v2 child-identity constants, types, and API interfaces while leaving every unsuffixed v1 export unchanged.

#### Why

A required child descriptor is a breaking API change. Establishing versioned types first gives later runtime work a stable target without changing existing callers.

#### How

- Export the v2 integration version, envelope version, frozen four-role catalog, role type, and child descriptor from `src/integration.ts`.
- Add suffixed v2 start options, API, request, and response types; v2 `startSubagent()` requires `child` and exposes `childRoles` and `childIdentityEnvelopeVersion`.
- Keep `OBSERVME_INTEGRATION_VERSION`, all unsuffixed API/type aliases, and `requestObservMeIntegration()` typed as v1.
- Add compile-time compatibility fixtures only; do not change provider registration or negotiation in this task.

#### Where

- `src/integration.ts`
- `test/integration-api.test.mjs`
- `test/pi-compatibility.test.ts`

#### Acceptance criteria

- Existing v1 imports and calls compile without edits.
- A v2 caller cannot type-check `startSubagent()` without a complete child descriptor.
- `OBSERVME_CHILD_ROLES` is frozen and exactly equals `lead`, `helper`, `worker`, `validator` in that order.
- The public role type is derived from the exported catalog rather than duplicated.

### 2. Add one reusable child-descriptor validator

- [x] Validate display name, role, and capability as one atomic value without performing observability work.

#### Why

JavaScript and package-decoupled clients can bypass TypeScript. One validator prevents API, propagation, and test fixtures from applying different rules.

#### How

- Add non-nested validation helpers for Unicode scalar values, code-point length, control characters, the exact role catalog, and the capability token grammar.
- Return a bounded value-free result that callers can map to `invalid_request` or propagation failure.
- Reject the entire descriptor if any field fails; never trim, normalize, or partially return fields.
- Add boundary tests for astral Unicode, lone surrogates, controls, exact limits, and every role.

#### Where

- `src/pi/child-identity.ts` (new)
- `test/child-identity.test.ts` (new)

#### Acceptance criteria

- Display names of exactly 128 Unicode code points and capabilities of exactly 64 valid ASCII characters are accepted.
- Empty, oversized, control-containing, invalid-Unicode, malformed-capability, and unknown-role values are rejected atomically.
- Rejected values never appear in errors or snapshots.
- Tests import the public role catalog, so runtime and type-level role sets cannot drift.

### 3. Add configurable child-identity environment keys

- [x] Extend configuration with envelope-version, display-name, and role environment keys.

#### Why

ObservMe owns propagation key names. Launchers such as OrcMe must use the environment returned by the API rather than hard-code ObservMe variables.

#### How

- Add default keys for child-identity envelope version, display name, and role; continue using `capabilityEnv` for capability.
- Include the keys in schema decoding, environment overrides where applicable, generated starter configuration, and collision validation.
- Reject duplicate names across every lineage, trace-context, and child-identity key.
- Document defaults and customization in the configuration reference and example.

#### Where

- `src/config/schema.ts`
- `src/config/defaults.ts`
- `src/config/validate.ts`
- `src/config/bootstrap-project-config.ts`
- `examples/observme.yaml`
- `docs/reference/12-configuration-reference.md`
- `test/config-defaults.test.mjs`
- `test/config-loader.test.mjs`
- `test/config-validation.test.mjs`

#### Acceptance criteria

- Defaults expose three distinct new keys and round-trip through supported config sources.
- Any collision with an existing propagation key fails validation with a bounded diagnostic.
- Generated configuration and `examples/observme.yaml` use the documented defaults.
- No propagation behavior changes until task 4.

### 4. Write and scrub the versioned child-identity envelope

- [x] Make child propagation write one complete v2 identity envelope and remove stale identity from every base environment.

#### Why

Writing identity fields independently can mix the selected child with stale parent or previous-child metadata.

#### How

- Pass a validated descriptor and explicit identity mode to the propagation builder.
- Add all child-identity keys to propagation scrubbing before writing any selected values.
- In v2 mode, write the envelope marker and all three descriptor fields after scrubbing.
- In v1 mode, omit the marker and descriptor fields and stop inheriting the parent's capability.
- Keep all existing workflow, parent, root, depth, spawn, and W3C propagation behavior unchanged.

#### Where

- `src/pi/agent-lineage.ts`
- `src/pi/subagent-spawn.ts`
- `test/agent-lineage.test.ts`
- `test/subagent-spawn.test.mjs`

#### Acceptance criteria

- V2 output contains one complete version-1 identity envelope with the requested values.
- Stale role, display-name, capability, and version values are removed before replacement.
- V1 output contains no identity marker or descriptor values and cannot inherit parent capability.
- Unrelated base environment entries remain byte-for-byte unchanged.

### 5. Read the envelope into child lineage

- [x] Hydrate a child runtime from only a complete supported envelope and fail open on invalid versions or values.

#### Why

A hand-built, stale, partial, or future envelope must not bypass API validation or produce partially labeled child telemetry.

#### How

- Parse the marker before reading any child-identity value.
- Reuse the task 2 validator for a complete version-1 descriptor.
- Add `displayName` to child lineage and use the descriptor's exact role and capability.
- Keep `root`, v2 child roles, and retained legacy/historical roles explicit in the internal model.
- Give documented trusted runtime options precedence over propagated metadata.
- Treat partial, malformed, contradictory, or unknown-version identity as one fail-open propagation failure with bounded value-free diagnostics.
- Update lineage documentation next to the implementation.

#### Where

- `src/pi/agent-lineage.ts`
- `src/pi/event-handlers/lifecycle.ts`
- `docs/agent-subagent-observability-requirements.md`
- `docs/reference/03-pi-event-and-session-model.md`
- `docs/reference/05-otel-pipeline-and-collector.md`
- `test/agent-lineage.test.ts`
- `test/pi-handlers.test.mjs`

#### Acceptance criteria

- `Scout` / `worker` / `code-search` hydrates as those exact values.
- An unknown envelope version does not interpret any identity field and emits one bounded value-free propagation diagnostic.
- Partial or malformed identity cannot produce a partially labeled lineage.
- An envelope-free v1 child retains documented legacy behavior without child capability.
- Tests distinguish OrcMe managed role/depth semantics from ObservMe lineage depth.

### 6. Retain the descriptor in parent lifecycle state

- [x] Carry one immutable descriptor through spawn state and the synthetic child tree node.

#### Why

The parent must show intended identity before the child exports and even when process launch fails.

#### How

- Add the validated descriptor to v2 internal start options and retained `SubagentSpawnState`.
- Build the synthetic child node from the descriptor while keeping `childAgentId` as the correlation key.
- Preserve the descriptor through start, wait, join, completion, launch failure, cancellation, and bounded eviction.
- Keep the v1 synthetic-child path metadata-free and legacy-compatible.

#### Where

- `src/pi/subagent-types.ts`
- `src/pi/subagent-spawn.ts`
- `src/pi/agent-tree-tracker.ts`
- `test/subagent-spawn.test.mjs`
- `test/agent-lineage.test.mjs`

#### Acceptance criteria

- Duplicate display names are accepted when technical child IDs differ.
- Every lifecycle transition retains byte-identical descriptor values.
- Launch failure before child startup still leaves the intended descriptor available to terminal parent telemetry.
- V1 state never synthesizes v2 metadata.

### 7. Register explicit v1 and v2 provider adapters

- [x] Make one session-backed provider respond with its highest mutually supported API version.

#### Why

The provider must offer v2 without silently changing the existing v1 object or launch behavior.

#### How

- Create explicit v1 and v2 API objects backed by the same session state.
- Expose frozen `childRoles` and `childIdentityEnvelopeVersion` on v2.
- Require and validate the complete descriptor before v2 calls the spawn path.
- Route v1 through the metadata-free identity mode and v2 through the descriptor mode.
- Respond once with the provider's highest version present in a structurally valid request.
- Preserve shutdown fencing and optional event-bus registration.

#### Where

- `src/pi/integration-api.ts`
- `src/pi/integration-registration.ts`
- `test/integration-api.test.mjs`
- `test/pi-handlers.test.mjs`

#### Acceptance criteria

- `[2, 1]` receives v2; `[1]` receives v1; unsupported or malformed requests receive no response.
- Invalid v2 descriptors return `invalid_request` before spans, tree state, metrics, logs, or returned environment change.
- V1 and v2 API objects have distinct structural shapes and frozen runtime catalogs.
- Session closing and unavailable-session results remain unchanged for both versions.

### 8. Select the highest synchronous provider response

- [x] Add deterministic multi-provider negotiation to the package helpers.

#### Why

First-response selection can choose an older provider solely because of Pi load order and can be changed unexpectedly by a late callback.

#### How

- Keep `requestObservMeIntegration()` v1-only and source-compatible.
- Add `requestObservMeIntegrationV2()` that advertises `[2, 1]` but returns only a selected v2 API.
- Collect structural responses until `events.emit()` returns, then select the highest version.
- Use first response only as a same-version tie-breaker and fence the holder against late responses.
- Keep discovery optional and fail-open when the event bus, provider, or compatible version is absent.

#### Where

- `src/integration.ts`
- `test/integration-api.test.mjs`
- `test/pi-compatibility.test.ts`

#### Acceptance criteria

- A later synchronous v2 response beats an earlier v1 response.
- Same-version providers resolve in Pi load order and only the selected lifecycle API is invoked.
- A response after `emit()` returns cannot replace the selection.
- A v1-only response makes the v2 helper return `undefined` without affecting the v1 helper.
- Structural guards do not rely on shared constructors or module identity.

### 9. Emit child identity in traces, logs, and resources

- [x] Add semantic attributes and apply them consistently to parent and child telemetry.

#### Why

Identity is useful only if the parent spawn and child runtime report the same unambiguous values.

#### How

- Add `pi.agent.display_name` and child-specific spawn attribute constants for display name, role, and capability.
- Emit child-prefixed attributes on parent spawn and terminal telemetry.
- Emit the same values as the child's own agent attributes in lineage-derived resource, span, and log data.
- Use existing bounded rendering and sanitization helpers for all human-facing or log-facing values.
- Document attribute scope and legacy values in the semantic-conventions reference.

#### Where

- `src/semconv/attributes.ts`
- `src/pi/agent-lineage.ts`
- `src/pi/subagent-spawn.ts`
- `src/pi/event-handlers/lifecycle.ts`
- `docs/reference/04-telemetry-semantic-conventions.md`
- `test/semconv-attributes.test.mjs`
- `test/subagent-spawn.test.mjs`
- `test/pi-handlers.test.mjs`

#### Acceptance criteria

- Parent and child telemetry agree on all three descriptor fields.
- Parent attributes use child-specific names and cannot be mistaken for the parent identity.
- Launch failure, completion, and cancellation retain the descriptor.
- V1 and historical role values remain documented and distinguishable from v2 values.

### 10. Show identity in `/obs agents` without metric leakage

- [x] Render display name, role, and capability in local agent views and lock metric cardinality.

#### Why

Operators need friendly identity locally, while high-cardinality display names and capabilities must never reach Prometheus labels.

#### How

- Extend `/obs agents` rows with the retained display name, exact role, and capability.
- Keep agent ID as the only lifecycle selector/correlation key.
- Audit every metric-label builder touched by lineage or subagent lifecycle and explicitly exclude display name and capability.
- Use the finite v2 role only where a metric already has documented child-role semantics; do not relabel parent metrics as child metrics.

#### Where

- `src/commands/obs-agents-runtime.ts`
- `src/commands/obs-agents.ts`
- `src/pi/subagent-spawn.ts`
- `test/obs-agents-command.test.mjs`
- `test/cardinality.test.ts`

#### Acceptance criteria

- `/obs agents` displays duplicate friendly names as separate rows with distinct technical IDs.
- Display name and capability are absent from every metric label set.
- Applicable role labels are limited to the fixed documented catalog plus explicit legacy values.
- No lifecycle operation accepts display name as an identifier.

### 11. Align dashboards and collector policy with exact roles

- [x] Update only the observability assets that inspect agent roles or promote identity attributes.

#### Why

Queries that collapse roles to legacy `subagent` or `worker` values would hide the four-role contract, while careless resource promotion could create unbounded labels.

#### How

- Use a bounded search to inventory dashboard panels, variables, alerts, and Collector processors that reference agent role, capability, or display name.
- Update affected role queries to preserve exact `lead`, `helper`, `worker`, and `validator` values plus documented legacy compatibility values.
- Keep display name and capability out of metric resource-to-label promotion.
- Update the dashboard reference and focused JSON/YAML tests; do not rewrite unrelated panels.

#### Where

- `dashboards/observme-agents.json`
- `dashboards/observme-agent-node-graphs.json`
- other `dashboards/*` files only when the inventory finds an affected role predicate
- `observability-stack/config/otel/otel-collector.yaml`
- `docs/reference/09-dashboards-alerts-slos.md`
- `test/dashboards.test.mjs`
- `test/alerts.test.mjs`
- `test/cardinality.test.ts`

#### Acceptance criteria

- Exact v2 roles remain queryable and are not collapsed to another label.
- Legacy v1/historical values remain visible during migration.
- No Collector rule promotes display name or capability into Prometheus labels.
- The task records the bounded inventory in tests or documentation so unrelated dashboards need no edits.

### 12. Upgrade the transport-neutral runner to v2

- [x] Require a child descriptor in runner options and forward it unchanged through the explicit v2 helper.

#### Why

The runner is the primary copyable integration path and must not silently drop identity into a v1 call.

#### How

- Add `child` to `ObservableSubagentRunOptions` and use `requestObservMeIntegrationV2()`.
- Forward the descriptor unchanged to v2 `startSubagent()`.
- If v2 is unavailable, follow the documented fail-open runner behavior without invoking v1 with missing identity.
- Preserve returned environment values and tombstones unchanged through the transport context.
- Add duplicate display-name, nested child, parent/child capability difference, and v2-unavailable examples in focused tests.

#### Where

- `examples/integrations/subagent-runner.ts`
- `test/subagent-runner-example.test.mjs`

#### Acceptance criteria

- The runner cannot type-check or start without a complete descriptor.
- Tests prove descriptor and environment object identity at the transport boundary.
- A missing v2 provider does not invoke a v1 lifecycle accidentally.
- Every nested launch must supply a fresh descriptor and use the newly returned environment.

### 13. Publish the wire and compatibility contract

- [x] Document helper-based and package-decoupled v2 integration without describing planned OrcMe behavior as already shipped.

#### Why

Separately installed Pi packages may not share module roots, and root API compatibility does not prove the explicitly loaded child extension can read the envelope.

#### How

- Document the stable event channel, structural request/response shapes, synchronous selection rules, v1/v2 behavior, lifecycle unions, validation bounds, and identity precedence.
- Document helper import for real ObservMe dependencies and local structural mirroring for intentionally decoupled packages.
- Define display name, role, capability, and technical IDs as separate concepts.
- State OrcMe's current API-v1 implementation separately from its approved planned four-role and future v2 adoption contract.
- Preserve OrcMe's documented direct-RPC environment bridge, `--no-extensions` child pin, policy semantics, fixed spawn type/reason, lifecycle ordering, and supplementary-telemetry boundary.
- Remove unresolved launcher-mapping language from architecture references only where the v2 contract now resolves it.

#### Where

- `docs/extension-integration.md`
- `docs/compatibility-matrix.md`
- `docs/agent-subagent-observability-requirements.md`
- `docs/reference/02-reference-architecture.md`
- `docs/reference/07-extension-implementation-blueprint.md`
- `README.md`

#### Acceptance criteria

- Public docs define all field bounds, defaults, version behavior, precedence, and cardinality restrictions.
- Docs state that separately installed packages cannot depend on shared module identity.
- Docs distinguish root provider API version from child envelope support and name the minimum compatible release once known.
- Docs use the OrcMe role order and meaning from `docs/agents-and-observability.md`: `lead`, `helper`, `worker`, `validator`.
- Docs state that ObservMe role telemetry grants no OrcMe authority and that OrcMe task state remains authoritative.

### 14. Add a package-decoupled OrcMe-shaped negotiation fixture

- [x] Prove v2 discovery and identity mapping with a standalone structural consumer that imports no ObservMe runtime API.

#### Why

Type-checking the package helper cannot prove the event-bus path used by a separately installed package with no ObservMe dependency.

#### How

- Define only the documented v2 structural interfaces in a standalone fixture.
- Emit `[2, 1]`, validate version, frozen role catalog, envelope version, and required lifecycle methods, and select responses using the documented rules.
- Model future OrcMe mapping from fixture inputs: durable display identity to display name, exact manifest role to role, and pinned definition name to capability.
- Prove OrcMe definition names accepted by its lowercase `.`/`-` grammar fit the ObservMe capability grammar without rewriting.
- Cover all four approved roles, disabled no-negotiation behavior, and required-identity rejection of a v1-only provider.
- Do not import OrcMe or ObservMe production modules.

#### Where

- `test/fixtures/orcme-integration-consumer.mjs` (new)
- `test/integration-api.test.mjs`
- `test/pi-compatibility.test.ts`

#### Acceptance criteria

- The fixture negotiates v2 over `pi.events` using structural checks only.
- `lead`, `helper`, `worker`, and `validator` map exactly without role inference or aliases.
- Definition-name capability values need no normalization.
- Disabled integration emits no request; required identity rejects v1 before launch.
- The fixture claims to model future OrcMe adoption, not current shipped v2 behavior.

### 15. Extend the fixture with OrcMe lifecycle and environment behavior

- [x] Prove the direct Pi RPC bridge, technical-ID retry, nesting, and lifecycle ordering independently of package imports.

#### Why

The highest integration risk is not type shape but preserving ObservMe's sanitized environment and exactly-once lifecycle behavior through OrcMe's direct RPC launch pattern.

#### How

- Build an OrcMe-shaped base environment containing only synthetic managed keys and stale lineage keys.
- Preserve every ObservMe return value and add explicit `undefined` tombstones for removed base keys before simulating Pi RPC's `process.env` overlay.
- Retry duplicate requested technical IDs once without those IDs and with a byte-identical child descriptor.
- Exercise nested delegation with a fresh descriptor and newly returned environment.
- Assert launch failure, wait, completion, and join ordering and exactly-once behavior.
- Never inspect or snapshot unrelated real environment values.

#### Where

- `test/fixtures/orcme-integration-consumer.mjs`
- `test/integration-api.test.mjs`
- `test/pi-handlers.test.mjs`

#### Acceptance criteria

- The simulated Pi RPC overlay cannot restore stale lineage or identity keys removed by ObservMe.
- Retry changes only technical identifier fields and preserves the complete descriptor.
- Nested launch uses the immediate parent's returned environment and an independently supplied child descriptor.
- Lifecycle calls match OrcMe's documented launch, wait, completion, and join order.
- Complete environment objects and unrelated values never enter snapshots or diagnostics.

### 16. Add a packed parent/child compatibility smoke

- [x] Verify one packed ObservMe artifact as both the parent provider and explicitly loaded child extension.

#### Why

Root negotiation alone cannot prove that a child launched with `--no-extensions` loads a release that understands envelope version 1.

#### How

- Extend the packaged-install smoke to install one built artifact in isolated parent and child package roots.
- Negotiate v2 in the parent, start a real Node child with the returned environment, and explicitly load the packed child extension.
- Have the child report bounded lineage attributes only; never print or snapshot the environment.
- Assert descriptor equality and absence of stale parent display name, role, and capability.
- Add the package release/envelope compatibility row to the public matrix.

#### Where

- `scripts/smoke-packaged-install.mjs`
- `test/agent-lineage.test.ts`
- `docs/compatibility-matrix.md`

#### Acceptance criteria

- The real child reports the requested descriptor and no parent identity leakage.
- Parent and child use separately resolved module roots from the same packed artifact.
- The smoke fails when child envelope support is removed or version-mismatched.
- No credential, prompt, command, or environment value is exposed.

### 17. Close the compatibility and privacy matrix

- [x] Fill remaining focused test gaps, update the changelog, and run the release-relevant validation commands.

#### Why

The contract crosses public types, event negotiation, runtime validation, process environment, parent state, child startup, telemetry, UI, and packaging. A final bounded matrix prevents a missed normative rule without turning earlier tasks into one oversized change.

#### How

- Map each normative bullet to an existing focused test; add only missing assertions to the owning test file.
- Add truth-table coverage for supported-version ordering, no overlap, malformed requests, shutdown fencing, and cached or late responses.
- Recheck that rejected raw values never enter diagnostics, logs, snapshots, or metric labels.
- Update `CHANGELOG.md` with the public v2 contract, v1 compatibility behavior, and minimum child release.
- Run the static, focused, package, and Pi compatibility checks once.

#### Normative coverage matrix

Rows follow the normative-contract bullets in order. Documentation-only rows describe compatibility or future-version policy that has no executable v2 behavior to assert.

| # | Normative rule | Focused evidence or rationale |
| --- | --- | --- |
| 1 | API v2 requires one complete child descriptor. | `test/pi-compatibility.test.ts` compile fixtures reject missing descriptor fields; `test/integration-api.test.mjs` checks the exact public constants. |
| 2 | V2 exposes a frozen role catalog and envelope version structurally. | `test/integration-api.test.mjs` checks the exact frozen fields and rejects malformed structural providers without module identity. |
| 3 | The helper is optional and the event channel is a wire contract. | `test/integration-api.test.mjs` exercises the standalone future OrcMe consumer; `test/pi-compatibility.test.ts` proves that fixture imports no production module. |
| 4 | Display name is presentation only, never correlation, authority, or a metric label. | `test/obs-agents-command.test.mjs` keeps duplicate names separate by technical ID; `test/cardinality.test.ts` excludes display name from correlation and metric labels. |
| 5 | V2 roles are exactly the exported four-role catalog. | `test/child-identity.test.ts` accepts every public role and rejects aliases; `test/integration-api.test.mjs` checks catalog order and freezing. |
| 6 | Role-catalog changes require a later API version. | Documentation-only version-evolution rule: `docs/extension-integration.md` states that v2 is fixed and any role change requires a later API version; the frozen catalog tests prevent in-version drift. |
| 7 | Role is descriptive and is not inferred or authoritative. | `test/integration-api.test.mjs` maps exact fixture roles and rejects aliases; `test/agent-lineage.test.ts` proves role does not determine lineage depth. The authority boundary is documented in `docs/extension-integration.md`. |
| 8 | Capability is a stable telemetry/UI value, not a metric label. | `test/subagent-spawn.test.mjs` and `test/pi-handlers.test.mjs` verify parent/child attributes; `test/cardinality.test.ts` excludes capability from metric labels and Collector promotion. |
| 9 | Runtime validation is atomic and precedes observability mutation. | `test/child-identity.test.ts` covers atomic value-free rejection; `test/integration-api.test.mjs` snapshots tree/span/log/metric state before rejected starts. |
| 10 | Display name and capability use the shared 128-code-point and 64-character bounds. | `test/child-identity.test.ts` covers exact limits, astral Unicode, controls, lone surrogates, and the capability grammar. |
| 11 | Parent child-specific telemetry and child own-agent telemetry agree. | `test/subagent-spawn.test.mjs` checks spawn and terminal telemetry; `test/pi-handlers.test.mjs` checks child resource, span, and log identity against the parent. |
| 12 | Selected child metadata replaces stale inherited parent metadata. | `test/agent-lineage.test.ts` and `test/subagent-spawn.test.mjs` verify complete replacement and unrelated-environment preservation. |
| 13 | Propagation scrubs all identity keys and rejects unknown future envelopes atomically. | `test/config-validation.test.mjs` covers key collisions; `test/agent-lineage.test.ts` proves unknown versions do not read identity fields; `test/pi-handlers.test.mjs` checks one bounded value-free diagnostic. |
| 14 | `root`, v2 roles, and legacy/historical roles remain distinct. | `test/child-identity.test.ts` rejects `root` as a child role; `test/agent-lineage.test.ts`, `test/cardinality.test.ts`, and `test/dashboards.test.mjs` preserve explicit current and legacy values. |
| 15 | OrcMe managed depth and ObservMe lineage depth are separate. | `test/agent-lineage.test.ts` verifies a managed depth-0 lead remains an ObservMe depth-1 child. |
| 16 | API v1 remains metadata-free and does not inherit capability. | `test/agent-lineage.test.mjs`, `test/agent-lineage.test.ts`, and `test/integration-api.test.mjs` check legacy `subagent`, no marker/name/capability, and no parent-capability inheritance. |
| 17 | Unsuffixed v1 exports stay source-compatible; v2 exports are explicit. | `test/pi-compatibility.test.ts` compile fixtures exercise both export generations; `test/integration-api.test.mjs` keeps the runtime API shapes distinct. |
| 18 | Negotiation chooses the highest synchronous overlap with deterministic ties and fencing. | `test/integration-api.test.mjs` contains the ordering/no-overlap/malformed truth table, same-version load-order and late-response tests; `test/pi-handlers.test.mjs` fences cached APIs during shutdown. |
| 19 | Root API compatibility does not prove child-envelope support. | `scripts/smoke-packaged-install.mjs`, exercised by the release checks, installs one tarball in separate parent/child roots and checks envelope version 1; `docs/compatibility-matrix.md` records 0.1.8 as the minimum child release. |
| 20 | Future OrcMe mapping preserves durable display identity, manifest role, definition capability, and technical IDs. | `test/integration-api.test.mjs` and `test/pi-handlers.test.mjs` exercise the dependency-free mapping, all four roles, nested delegation, and unchanged technical identifiers. |
| 21 | OrcMe policy remains explicit and export failure stays supplementary. | `test/integration-api.test.mjs` proves disabled emits no request and required identity rejects v1. `inherit`, enabled child pinning, and export-failure behavior are documentation-only downstream launcher policy in `docs/extension-integration.md`. |
| 22 | OrcMe preserves the returned environment and tombstones without exposing it. | `test/integration-api.test.mjs` simulates the Pi RPC overlay and verifies removed keys cannot return; fixtures use only synthetic bounded values and never snapshot a real environment. |
| 23 | OrcMe keeps fixed spawn type/reason and retries duplicate technical IDs once with identical identity. | `test/integration-api.test.mjs` checks `extension` / `delegated_task`, one retry without requested IDs, and object/byte-identical descriptor and environment values. |
| 24 | Lifecycle launch/fail/wait/complete/join ordering remains exactly once. | `test/integration-api.test.mjs` checks successful and failed fixture call order; `test/subagent-runner-example.test.mjs` and `test/subagent-spawn.test.mjs` preserve terminal outcomes. |
| 25 | Untrusted identity/content follows value-free diagnostics and existing content safety. | `test/child-identity.test.ts` and `test/integration-api.test.mjs` check rejected sentinels against diagnostics/log/snapshot/metric state; `test/agent-lineage.test.ts` and `test/cardinality.test.ts` cover inherited values and labels. |

#### Where

- Focused test files named by tasks 1–16
- `CHANGELOG.md`

#### Acceptance criteria

- Every normative rule has one identified focused test or an explicit documentation-only rationale.
- V1 launchers and separately loaded older children retain the documented metadata-free compatibility path.
- `npm run typecheck`, `npm run typecheck:test`, focused child-identity tests, `npm run check:pack`, and `npm run validate:pi-compatibility` pass.
- `CHANGELOG.md` records both v2 behavior and the unchanged authority/privacy boundaries.
- This task contains no unrelated refactor or catch-all feature work.

## Out of scope

- Using display name or capability as an unrestricted Prometheus label.
- Replacing `pi.agent.id` with a launcher-provided name.
- Inferring descriptors from prompts, command lines, model names, Markdown agent files, tmux pane names, tool arguments, role depth, or definition names.
- Adding orchestration authorization or deciding which child roles a launcher may execute.
- Making the v2 role catalog runtime-configurable; future catalog changes use integration API version negotiation.
- Generating OrcMe personas or display names inside ObservMe; the launcher owns and persists presentation identity.
- Making ObservMe a control-plane authority for OrcMe roles, assignments, retries, recovery, task settlement, validation independence, or finalization.
- Modifying the OrcMe repository as part of these ObservMe implementation tasks; OrcMe adoption remains a coordinated downstream change against the published v2 contract.
- Renaming existing workflows, sessions, or already-exported telemetry.
