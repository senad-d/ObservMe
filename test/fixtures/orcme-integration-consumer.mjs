// Standalone structural consumer for planned future OrcMe v2 adoption.
// This fixture does not describe current shipped OrcMe v2 behavior.

const integrationChannel = "observme:integration:request";
const supportedVersions = Object.freeze([2, 1]);
const childRoles = Object.freeze(["lead", "helper", "worker", "validator"]);
const requiredLifecycleMethods = Object.freeze([
  "getContext",
  "startSubagent",
  "completeSubagent",
  "failSubagent",
  "startWait",
  "endWait",
  "startJoin",
  "endJoin",
]);
const futureOrcMeDefinitionNamePattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const observMeCapabilityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const duplicateTechnicalIdentifierReasons = Object.freeze([
  "spawn_already_exists",
  "child_agent_already_exists",
]);

export function createFutureOrcMeManagedBaseEnvironment() {
  return {
    ORCME_MANAGED_TASK_ID: "task-fixture",
    ORCME_MANAGED_ATTEMPT_ID: "attempt-fixture",
    OBSERVME_WORKFLOW_ID: "workflow-stale-fixture",
    OBSERVME_AGENT_ID: "agent-stale-fixture",
    OBSERVME_PARENT_AGENT_ID: "parent-stale-fixture",
    OBSERVME_ROOT_AGENT_ID: "root-stale-fixture",
    OBSERVME_PARENT_SESSION_ID: "session-stale-fixture",
    OBSERVME_PARENT_TRACE_ID: "7".repeat(32),
    OBSERVME_PARENT_SPAN_ID: "8".repeat(16),
    OBSERVME_AGENT_DEPTH: "63",
    OBSERVME_SPAWN_ID: "spawn-stale-fixture",
    OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION: "99",
    OBSERVME_AGENT_DISPLAY_NAME: "Stale fixture display name",
    OBSERVME_AGENT_ROLE: "stale-fixture-role",
    OBSERVME_AGENT_CAPABILITY: "stale-fixture-capability",
    traceparent: `00-${"3".repeat(32)}-${"4".repeat(16)}-01`,
    tracestate: "fixture=stale",
    TRACEPARENT: `00-${"5".repeat(32)}-${"6".repeat(16)}-01`,
    TRACESTATE: "fixture=uppercase-stale",
  };
}

export function startFutureOrcMePiRpcDelegation(api, input) {
  const startOptions = {
    ...(input.requestedSpawnId ? { spawnId: input.requestedSpawnId } : {}),
    ...(input.requestedChildAgentId ? { childAgentId: input.requestedChildAgentId } : {}),
    child: input.child,
    command: "pi",
    args: ["--no-extensions", "--mode", "rpc"],
    spawnType: "extension",
    spawnReason: "delegated_task",
    env: input.baseEnvironment,
  };
  let result = api.startSubagent(startOptions);
  let technicalIdsRetried = false;

  if (shouldRetryWithoutTechnicalIds(result, startOptions)) {
    const retryOptions = { ...startOptions };
    delete retryOptions.spawnId;
    delete retryOptions.childAgentId;
    technicalIdsRetried = true;
    result = api.startSubagent(retryOptions);
  }
  if (!result?.ok) return result;

  return {
    ok: true,
    spawnId: result.spawnId,
    childAgentId: result.childAgentId,
    observMeEnvironment: result.env,
    rpcEnvironment: bridgeFutureOrcMePiRpcEnvironment(input.baseEnvironment, result.env),
    traceContextPropagated: result.traceContextPropagated,
    technicalIdsRetried,
  };
}

export function bridgeFutureOrcMePiRpcEnvironment(baseEnvironment, observMeEnvironment) {
  const bridgedEnvironment = { ...observMeEnvironment };
  for (const key of Object.keys(baseEnvironment)) {
    if (!Object.hasOwn(observMeEnvironment, key)) bridgedEnvironment[key] = undefined;
  }
  return bridgedEnvironment;
}

export function simulateFutureOrcMePiRpcOverlay(rpcProcessEnvironment, childEnvironment) {
  const effectiveEnvironment = { ...rpcProcessEnvironment };
  for (const [key, value] of Object.entries(childEnvironment)) {
    if (value === undefined) delete effectiveEnvironment[key];
    else effectiveEnvironment[key] = value;
  }
  return effectiveEnvironment;
}

export async function runFutureOrcMePiRpcLifecycle(api, input) {
  const started = startFutureOrcMePiRpcDelegation(api, input);
  if (!started?.ok) return started;

  let handle;
  try {
    handle = await input.launch({
      environment: started.rpcEnvironment,
      spawnId: started.spawnId,
      childAgentId: started.childAgentId,
    });
  } catch (error) {
    api.failSubagent(started.spawnId, {
      childAgentId: started.childAgentId,
      errorClass: "launcher_error",
    });
    throw error;
  }

  api.completeSubagentLaunch?.(started.spawnId, {
    childAgentId: started.childAgentId,
  });

  const wait = api.startWait({
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: "active",
    reason: "child_running",
  });
  const terminal = await input.waitForTerminal(handle);
  if (wait?.ok) {
    api.endWait(wait.id, createFutureOrcMeTerminalLifecycleFields(started, terminal, "child_running"));
  }
  api.completeSubagent(started.spawnId, {
    childAgentId: started.childAgentId,
    childStatus: terminal.childStatus,
    outcome: terminal.outcome,
  });

  const join = api.startJoin(
    createFutureOrcMeTerminalLifecycleFields(started, terminal, "dependency"),
  );
  const evidence = await input.collectTerminalEvidence(handle);
  if (join?.ok) {
    api.endJoin(join.id, createFutureOrcMeTerminalLifecycleFields(started, terminal, "dependency"));
  }

  return { ...started, evidence, terminal };
}

export function requestFutureOrcMeObservMeV2(host, integrationPolicy = "enabled") {
  if (integrationPolicy === "disabled") return undefined;
  if (integrationPolicy !== "enabled") throw new TypeError("Unsupported future OrcMe integration policy fixture value.");

  const eventBus = resolveEventBus(host);
  if (!eventBus) return undefined;

  const holder = { accepting: true, version: undefined, api: undefined };
  const request = {
    supportedVersions,
    respond: receiveStructuralCandidate.bind(undefined, holder),
  };

  try {
    Reflect.apply(eventBus.emit, eventBus.events, [integrationChannel, request]);
  } catch {
    return undefined;
  } finally {
    holder.accepting = false;
  }

  return holder.version === 2 ? holder.api : undefined;
}

export function mapFutureOrcMeChildDescriptor(input) {
  if (!input || typeof input !== "object") throw new TypeError("Future OrcMe identity input is required.");

  const durableDisplayIdentity = Reflect.get(input, "durableDisplayIdentity");
  const manifestRole = Reflect.get(input, "manifestRole");
  const pinnedDefinitionName = Reflect.get(input, "pinnedDefinitionName");

  if (typeof durableDisplayIdentity !== "string" || durableDisplayIdentity.length === 0) {
    throw new TypeError("Future OrcMe durable display identity is required.");
  }
  if (!isApprovedChildRole(manifestRole)) throw new TypeError("Future OrcMe manifest role is not approved.");
  if (!isFutureOrcMeDefinitionName(pinnedDefinitionName)) {
    throw new TypeError("Future OrcMe pinned definition name is invalid.");
  }
  if (!observMeCapabilityPattern.test(pinnedDefinitionName)) {
    throw new TypeError("Future OrcMe definition-name grammar must remain within the ObservMe capability grammar.");
  }

  return Object.freeze({
    displayName: durableDisplayIdentity,
    role: manifestRole,
    capability: pinnedDefinitionName,
  });
}

export function isFutureOrcMeDefinitionName(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64
    && futureOrcMeDefinitionNamePattern.test(value);
}

function resolveEventBus(host) {
  if (!host || typeof host !== "object") return undefined;
  try {
    const events = Reflect.get(host, "events");
    if (!events || typeof events !== "object") return undefined;
    const emit = Reflect.get(events, "emit");
    return typeof emit === "function" ? { events, emit } : undefined;
  } catch {
    return undefined;
  }
}

function receiveStructuralCandidate(holder, candidate) {
  if (!holder.accepting) return;

  const version = classifyStructuralCandidate(candidate);
  if (version === undefined || holder.version !== undefined && holder.version >= version) return;
  holder.version = version;
  holder.api = candidate;
}

function classifyStructuralCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return undefined;
  try {
    const version = Reflect.get(candidate, "version");
    if (!hasRequiredLifecycleMethods(candidate)) return undefined;
    if (version === 1) return 1;
    if (version !== 2) return undefined;
    if (Reflect.get(candidate, "childIdentityEnvelopeVersion") !== 1) return undefined;
    return hasExactFrozenRoleCatalog(Reflect.get(candidate, "childRoles")) ? 2 : undefined;
  } catch {
    return undefined;
  }
}

function hasRequiredLifecycleMethods(candidate) {
  for (const method of requiredLifecycleMethods) {
    if (typeof Reflect.get(candidate, method) !== "function") return false;
  }
  return true;
}

function hasExactFrozenRoleCatalog(value) {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length !== childRoles.length) return false;
  for (let index = 0; index < childRoles.length; index += 1) {
    if (value[index] !== childRoles[index]) return false;
  }
  return true;
}

function isApprovedChildRole(value) {
  for (const role of childRoles) {
    if (value === role) return true;
  }
  return false;
}

function shouldRetryWithoutTechnicalIds(result, startOptions) {
  if (result?.ok || !duplicateTechnicalIdentifierReasons.includes(result?.reason)) return false;
  return Object.hasOwn(startOptions, "spawnId") || Object.hasOwn(startOptions, "childAgentId");
}

function createFutureOrcMeTerminalLifecycleFields(started, terminal, reason) {
  return {
    spawnId: started.spawnId,
    childAgentId: started.childAgentId,
    childStatus: terminal.childStatus,
    joinStatus: terminal.joinStatus,
    reason,
    ...(terminal.failurePropagated === undefined ? {} : { failurePropagated: terminal.failurePropagated }),
  };
}
