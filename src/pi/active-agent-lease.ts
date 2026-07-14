import type { Attributes, ObservableCallback, ObservableGauge, ObservableResult } from "@opentelemetry/api";

export interface ActiveAgentLeaseController {
  readonly active: boolean;
  readonly disposed: boolean;
  activate: () => void;
  deactivate: () => void;
  dispose: () => void;
}

export interface CreateActiveAgentLeaseOptions {
  readonly instrument: ObservableGauge;
  readonly leaseDurationMillis: number;
  readonly attributes?: Attributes;
  readonly wallClockNow?: () => number;
  readonly enabled?: boolean;
}

interface ActiveAgentLeaseState {
  readonly leaseDurationMillis: number;
  readonly attributes: Attributes;
  readonly wallClockNow: () => number;
  active: boolean;
  disposed: boolean;
}

export function createActiveAgentLease(
  options: CreateActiveAgentLeaseOptions,
): ActiveAgentLeaseController | undefined {
  if (options.enabled === false) return undefined;
  return new SessionActiveAgentLease(options);
}

export function computeActiveAgentLeaseExpiryUnixSeconds(
  wallClockUnixMillis: number,
  leaseDurationMillis: number,
): number | undefined {
  if (!Number.isFinite(wallClockUnixMillis) || !Number.isFinite(leaseDurationMillis)) return undefined;

  const expiryMillis = wallClockUnixMillis + leaseDurationMillis;
  if (!Number.isFinite(expiryMillis)) return undefined;

  const expiryUnixSeconds = expiryMillis / 1000;
  return Number.isFinite(expiryUnixSeconds) ? expiryUnixSeconds : undefined;
}

function observeActiveAgentLease(state: ActiveAgentLeaseState, result: ObservableResult): void {
  if (!state.active || state.disposed) return;

  const expiryUnixSeconds = computeActiveAgentLeaseExpiryUnixSeconds(
    state.wallClockNow(),
    state.leaseDurationMillis,
  );
  if (expiryUnixSeconds === undefined) return;

  result.observe(expiryUnixSeconds, state.attributes);
}

class SessionActiveAgentLease implements ActiveAgentLeaseController {
  readonly #instrument: ObservableGauge;
  readonly #state: ActiveAgentLeaseState;
  readonly #callback: ObservableCallback;

  constructor(options: CreateActiveAgentLeaseOptions) {
    this.#instrument = options.instrument;
    this.#state = {
      leaseDurationMillis: options.leaseDurationMillis,
      attributes: { ...options.attributes },
      wallClockNow: options.wallClockNow ?? Date.now,
      active: false,
      disposed: false,
    };
    this.#callback = observeActiveAgentLease.bind(undefined, this.#state);
    this.#instrument.addCallback(this.#callback);
  }

  get active(): boolean {
    return this.#state.active;
  }

  get disposed(): boolean {
    return this.#state.disposed;
  }

  activate(): void {
    if (this.#state.disposed) return;
    this.#state.active = true;
  }

  deactivate(): void {
    this.#state.active = false;
  }

  dispose(): void {
    if (this.#state.disposed) return;

    this.#state.active = false;
    this.#state.disposed = true;
    this.#instrument.removeCallback(this.#callback);
  }
}
