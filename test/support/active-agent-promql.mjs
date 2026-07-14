export const ACTIVE_AGENT_FUTURE_HORIZON_SECONDS = 305;

const ACTIVE_AGENT_CLAIM = "observme_active_agents > 0";
const ACTIVE_AGENT_VALID_LEASE =
  "(observme_agent_lease_expires_unixtime_seconds > time()) and (observme_agent_lease_expires_unixtime_seconds <= time() + 305)";
const ACTIVE_AGENT_JOIN =
  `(${ACTIVE_AGENT_CLAIM}) and on (observme_instance_id) (${ACTIVE_AGENT_VALID_LEASE})`;

export const CANONICAL_ACTIVE_AGENT_TOTAL_PROMQL =
  `sum(max by (observme_instance_id) (${ACTIVE_AGENT_JOIN})) or vector(0)`;
export const CANONICAL_ACTIVE_AGENT_BY_ROLE_PROMQL = canonicalActiveAgentBreakdownPromql("agent_role");
export const CANONICAL_ACTIVE_AGENT_BY_ENVIRONMENT_PROMQL = canonicalActiveAgentBreakdownPromql("environment");
export const CANONICAL_ACTIVE_AGENT_BY_DEPTH_PROMQL = canonicalActiveAgentBreakdownPromql("subagent_depth");
export const CANONICAL_RAW_ACTIVE_AGENT_CLAIMS_PROMQL =
  `sum(max by (observme_instance_id) (${ACTIVE_AGENT_CLAIM})) or vector(0)`;
export const CANONICAL_EXPIRED_ACTIVE_AGENT_CLAIMS_PROMQL =
  `sum(max by (observme_instance_id) ((${ACTIVE_AGENT_CLAIM}) and on (observme_instance_id) (observme_agent_lease_expires_unixtime_seconds <= time()))) or vector(0)`;

export function canonicalActiveAgentBreakdownPromql(dimension) {
  return `sum by (${dimension}) (max by (observme_instance_id, ${dimension}) (${ACTIVE_AGENT_JOIN})) or on() vector(0)`;
}

export function canonicalActiveAgentBreakdownCorePromql(dimension) {
  return `sum by (${dimension}) (max by (observme_instance_id, ${dimension}) (${ACTIVE_AGENT_JOIN}))`;
}

export function evaluateCanonicalActiveAgentTotal(fixture, nowSeconds) {
  let total = 0;
  for (const claim of activeClaimsByInstance(fixture, nowSeconds).values()) total += claim.value;
  return total;
}

export function evaluateCanonicalActiveAgentBreakdown(fixture, nowSeconds, dimension) {
  const activeClaims = activeClaimsByInstance(fixture, nowSeconds);
  const totals = new Map();

  for (const claim of activeClaims.values()) {
    const dimensionValue = claim.labels?.[dimension] ?? "";
    totals.set(dimensionValue, (totals.get(dimensionValue) ?? 0) + claim.value);
  }

  return totals;
}

function activeClaimsByInstance(fixture, nowSeconds) {
  const validLeaseInstances = validLeaseInstanceIds(fixture.leases, nowSeconds);
  const activeClaims = new Map();

  for (const claim of fixture.claims) {
    if (!(claim.value > 0) || !validLeaseInstances.has(claim.observmeInstanceId)) continue;

    const current = activeClaims.get(claim.observmeInstanceId);
    if (!current || claim.value > current.value) activeClaims.set(claim.observmeInstanceId, claim);
  }

  return activeClaims;
}

function validLeaseInstanceIds(leases, nowSeconds) {
  const instanceIds = new Set();
  const latestAllowedExpiry = nowSeconds + ACTIVE_AGENT_FUTURE_HORIZON_SECONDS;

  for (const lease of leases) {
    if (!Number.isFinite(lease.value)) continue;
    if (lease.value > nowSeconds && lease.value <= latestAllowedExpiry) {
      instanceIds.add(lease.observmeInstanceId);
    }
  }

  return instanceIds;
}
