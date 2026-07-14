import assert from "node:assert/strict";
import test from "node:test";
import type { Attributes, ObservableCallback, ObservableResult } from "@opentelemetry/api";
import {
  createActiveAgentLease,
  computeActiveAgentLeaseExpiryUnixSeconds,
} from "../src/pi/active-agent-lease.ts";
import {
  ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM,
  ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM,
} from "../src/config/schema.ts";

interface LeaseObservation {
  readonly value: number;
  readonly attributes: Attributes;
}

class TestObservableGauge {
  readonly observations: LeaseObservation[] = [];
  readonly #callbacks = new Set<ObservableCallback>();
  removeCallbackCalls = 0;

  get callbackCount(): number {
    return this.#callbacks.size;
  }

  addCallback(callback: ObservableCallback): void {
    this.#callbacks.add(callback);
  }

  removeCallback(callback: ObservableCallback): void {
    this.removeCallbackCalls += 1;
    this.#callbacks.delete(callback);
  }

  async collect(): Promise<void> {
    const result: ObservableResult = { observe: this.observe.bind(this) };
    for (const callback of [...this.#callbacks]) await callback(result);
  }

  private observe(value: number, attributes: Attributes = {}): void {
    this.observations.push({ value, attributes: { ...attributes } });
  }
}

function createLease(
  gauge: TestObservableGauge,
  wallClockNow: () => number,
  leaseDurationMillis = 60_000,
) {
  const controller = createActiveAgentLease({
    instrument: gauge,
    leaseDurationMillis,
    wallClockNow,
    attributes: { environment: "test", agent_role: "root" },
  });
  assert.ok(controller);
  return controller;
}

test("active lease observes the exact configured expiry and renews on every collection", async () => {
  const gauge = new TestObservableGauge();
  let nowMillis = 1_700_000_000_250;
  const lease = createLease(gauge, () => nowMillis);

  assert.equal(gauge.callbackCount, 1);
  assert.equal(lease.active, false);
  await gauge.collect();
  assert.deepEqual(gauge.observations, []);

  lease.activate();
  await gauge.collect();
  nowMillis += 15_000;
  await gauge.collect();

  assert.deepEqual(gauge.observations, [
    {
      value: 1_700_000_060.25,
      attributes: { environment: "test", agent_role: "root" },
    },
    {
      value: 1_700_000_075.25,
      attributes: { environment: "test", agent_role: "root" },
    },
  ]);
});

test("lease renewal follows forward and backward wall-clock movement and omits non-finite clocks", async () => {
  const gauge = new TestObservableGauge();
  let nowMillis = 100_000;
  const lease = createLease(gauge, () => nowMillis);
  lease.activate();

  await gauge.collect();
  nowMillis = 40_000;
  await gauge.collect();
  nowMillis = 250_000;
  await gauge.collect();
  nowMillis = Number.NaN;
  await gauge.collect();
  nowMillis = Number.POSITIVE_INFINITY;
  await gauge.collect();
  nowMillis = Number.NEGATIVE_INFINITY;
  await gauge.collect();

  assert.deepEqual(
    gauge.observations.map(observation => observation.value),
    [160, 100, 310],
  );
});

test("duration boundaries preserve fractional Unix-second lease arithmetic", () => {
  assert.equal(
    computeActiveAgentLeaseExpiryUnixSeconds(250, ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM),
    10.25,
  );
  assert.equal(
    computeActiveAgentLeaseExpiryUnixSeconds(250, ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM),
    300.25,
  );
  assert.equal(computeActiveAgentLeaseExpiryUnixSeconds(Number.NaN, 60_000), undefined);
  assert.equal(computeActiveAgentLeaseExpiryUnixSeconds(0, Number.POSITIVE_INFINITY), undefined);
  assert.equal(computeActiveAgentLeaseExpiryUnixSeconds(Number.MAX_VALUE, Number.MAX_VALUE), undefined);
});

test("activation and deactivation are repeatable without adding callbacks or renewing while inactive", async () => {
  const gauge = new TestObservableGauge();
  let nowMillis = 1_000;
  const lease = createLease(gauge, () => nowMillis);

  lease.activate();
  lease.activate();
  await gauge.collect();
  assert.equal(gauge.callbackCount, 1);
  assert.deepEqual(gauge.observations.map(observation => observation.value), [61]);

  lease.deactivate();
  lease.deactivate();
  nowMillis = 2_000;
  await gauge.collect();
  assert.deepEqual(gauge.observations.map(observation => observation.value), [61]);

  lease.activate();
  await gauge.collect();
  assert.deepEqual(gauge.observations.map(observation => observation.value), [61, 62]);
});

test("disposing removes the callback and prevents collection or reactivation after shutdown", async () => {
  const gauge = new TestObservableGauge();
  let nowMillis = 1_000;
  const lease = createLease(gauge, () => nowMillis);
  lease.activate();
  await gauge.collect();

  lease.dispose();
  lease.dispose();
  nowMillis = 2_000;
  lease.activate();
  await gauge.collect();

  assert.equal(lease.active, false);
  assert.equal(lease.disposed, true);
  assert.equal(gauge.callbackCount, 0);
  assert.equal(gauge.removeCallbackCalls, 1);
  assert.deepEqual(gauge.observations.map(observation => observation.value), [61]);
});

test("metrics-disabled mode does not register an observable callback", async () => {
  const gauge = new TestObservableGauge();
  const lease = createActiveAgentLease({
    instrument: gauge,
    leaseDurationMillis: 60_000,
    wallClockNow: () => 1_000,
    enabled: false,
  });

  await gauge.collect();
  assert.equal(lease, undefined);
  assert.equal(gauge.callbackCount, 0);
  assert.deepEqual(gauge.observations, []);
});
