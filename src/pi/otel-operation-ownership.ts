import type {
  BoundedOtelOperationResult,
  OtelOperationSettlement,
} from "../otel/shutdown.ts";

type OtelOperation = BoundedOtelOperationResult["operation"];
type OtelOperationRetry = () => Promise<BoundedOtelOperationResult>;
type OtelOperationSettlementObserver = (settlement: OtelOperationSettlement) => void;
type OwnedOperationState = "settling" | "retryable";

interface OwnedOtelOperation {
  readonly operation: OtelOperation;
  readonly retry: OtelOperationRetry;
  readonly observeSettlement: OtelOperationSettlementObserver;
  state: OwnedOperationState;
}

export interface OtelOperationOwnership {
  readonly hasUnresolvedOperations: boolean;
  retain: (
    result: BoundedOtelOperationResult,
    retry: OtelOperationRetry,
    observeSettlement: OtelOperationSettlementObserver,
  ) => void;
  resolveBeforeStart: () => Promise<boolean>;
  takeStartupDiagnostic: () => boolean;
}

const PROCESS_OWNERSHIP_KEY = Symbol.for("@senad-d/observme.otel-operation-ownership.v1");
const operationRetryOrder: readonly OtelOperation[] = ["flush", "shutdown"];

type ObservMeProcessGlobal = typeof globalThis & {
  [PROCESS_OWNERSHIP_KEY]?: OtelOperationOwnership;
};

export function createOtelOperationOwnership(): OtelOperationOwnership {
  return new ProcessOtelOperationOwnership();
}

export function getProcessOtelOperationOwnership(): OtelOperationOwnership {
  const processGlobal = globalThis as ObservMeProcessGlobal;
  const existing = processGlobal[PROCESS_OWNERSHIP_KEY];
  if (existing) return existing;

  const ownership = createOtelOperationOwnership();
  Object.defineProperty(processGlobal, PROCESS_OWNERSHIP_KEY, {
    configurable: false,
    enumerable: false,
    value: ownership,
    writable: false,
  });
  return ownership;
}

class ProcessOtelOperationOwnership implements OtelOperationOwnership {
  readonly #operations = new Map<OtelOperation, OwnedOtelOperation>();
  #diagnosticEmitted = false;
  #resolution?: Promise<boolean>;

  get hasUnresolvedOperations(): boolean {
    return this.#operations.size > 0;
  }

  retain(
    result: BoundedOtelOperationResult,
    retry: OtelOperationRetry,
    observeSettlement: OtelOperationSettlementObserver,
  ): void {
    if (operationCompleted(result)) return;

    const ownedOperation: OwnedOtelOperation = {
      operation: result.operation,
      retry,
      observeSettlement,
      state: operationCanRetry(result) ? "retryable" : "settling",
    };
    this.#operations.set(result.operation, ownedOperation);
    this.observePendingSettlement(ownedOperation, result.settlement);
  }

  async resolveBeforeStart(): Promise<boolean> {
    if (this.#resolution) return this.#resolution;

    const resolution = this.retryUnresolvedOperations();
    this.#resolution = resolution;
    return this.finishResolution(resolution);
  }

  takeStartupDiagnostic(): boolean {
    if (!this.hasUnresolvedOperations || this.#diagnosticEmitted) return false;
    this.#diagnosticEmitted = true;
    return true;
  }

  private async finishResolution(resolution: Promise<boolean>): Promise<boolean> {
    try {
      return await resolution;
    } finally {
      if (this.#resolution === resolution) this.#resolution = undefined;
    }
  }

  private async retryUnresolvedOperations(): Promise<boolean> {
    for (const operation of operationRetryOrder) {
      const ownedOperation = this.#operations.get(operation);
      if (!ownedOperation) continue;
      if (ownedOperation.state === "settling") return false;

      const result = await ownedOperation.retry();
      if (operationCompleted(result)) {
        this.release(ownedOperation);
        continue;
      }

      ownedOperation.state = operationCanRetry(result) ? "retryable" : "settling";
      this.observePendingSettlement(ownedOperation, result.settlement);
      return false;
    }

    return !this.hasUnresolvedOperations;
  }

  private observePendingSettlement(
    ownedOperation: OwnedOtelOperation,
    settlement: Promise<OtelOperationSettlement> | undefined,
  ): void {
    if (!settlement) return;
    ownedOperation.state = "settling";
    void this.applyPendingSettlement(ownedOperation, settlement);
  }

  private async applyPendingSettlement(
    ownedOperation: OwnedOtelOperation,
    settlementPromise: Promise<OtelOperationSettlement>,
  ): Promise<void> {
    const settlement = await resolveSettlement(ownedOperation.operation, settlementPromise);
    notifySettlementObserver(ownedOperation.observeSettlement, settlement);
    if (this.#operations.get(ownedOperation.operation) !== ownedOperation) return;

    if (operationCompleted(settlement)) {
      this.release(ownedOperation);
      return;
    }
    ownedOperation.state = "retryable";
  }

  private release(ownedOperation: OwnedOtelOperation): void {
    if (this.#operations.get(ownedOperation.operation) !== ownedOperation) return;
    this.#operations.delete(ownedOperation.operation);
    if (this.#operations.size === 0) this.#diagnosticEmitted = false;
  }
}

async function resolveSettlement(
  operation: OtelOperation,
  settlementPromise: Promise<OtelOperationSettlement>,
): Promise<OtelOperationSettlement> {
  try {
    return await settlementPromise;
  } catch (error) {
    return { operation, completed: false, timedOut: false, error };
  }
}

function notifySettlementObserver(
  observer: OtelOperationSettlementObserver,
  settlement: OtelOperationSettlement,
): void {
  try {
    observer(settlement);
  } catch {
    return;
  }
}

function operationCompleted(
  result: Pick<BoundedOtelOperationResult, "completed" | "timedOut" | "error">,
): boolean {
  return result.completed && !result.timedOut && !result.error;
}

function operationCanRetry(result: BoundedOtelOperationResult): boolean {
  return !result.timedOut && !result.settlement;
}
