export const RUNTIME_EVENT_OUTCOMES = ["success", "failure", "rejected", "unchanged", "observation-gap"] as const;

export type RuntimeEventOutcome = (typeof RUNTIME_EVENT_OUTCOMES)[number];

export interface RuntimeIdentityInput {
  /** Explicit test seam. Production callers should omit this value. */
  readonly username?: string;
  /** Explicit test seam. Production callers should omit this value. */
  readonly hostname?: string;
}

export interface RuntimeLedgerOptions {
  readonly vaultPath: string;
  /** Overrides OMS_RUNTIME_ROOT for this call. Intended for tests and embedding hosts. */
  readonly runtimeRoot?: string;
  /** Explicit identity injection; omitted fields use the current process host identity. */
  readonly identity?: RuntimeIdentityInput;
}

export interface RuntimeInvocationInput {
  readonly surface: string;
  readonly operation: string;
  readonly packageVersion?: string | null;
  readonly gitCommit?: string | null;
}

export interface RuntimeInvocation {
  readonly invocationId: string;
  readonly observedAt: string;
  readonly surface: string;
  readonly operation: string;
  readonly packageVersion: string | null;
  readonly gitCommit: string | null;
}

export interface RuntimeEventInput {
  readonly attemptN?: number;
  readonly transactionId?: string | null;
  /** Time of the underlying mutation, not the time it was observed or committed. */
  readonly eventTime?: string | null;
  readonly kind: string;
  readonly outcome: RuntimeEventOutcome;
  readonly changedBetweenFrom?: string | null;
  readonly changedBetweenTo?: string | null;
  readonly templateId?: string | null;
  readonly notePath?: string | null;
  readonly inputSignature?: string | null;
  readonly templateSignature?: string | null;
}

export interface RuntimeEvent {
  readonly eventId: string;
  readonly invocationId: string;
  readonly attemptN: number;
  readonly transactionId: string | null;
  readonly eventTime: string | null;
  readonly observedAt: string;
  readonly kind: string;
  readonly outcome: RuntimeEventOutcome;
  readonly changedBetweenFrom: string | null;
  readonly changedBetweenTo: string | null;
  readonly surface: string;
  readonly operation: string;
  readonly templateId: string | null;
  readonly notePath: string | null;
  readonly inputSignature: string | null;
  readonly templateSignature: string | null;
  readonly packageVersion: string | null;
  readonly gitCommit: string | null;
}

export interface StoredRuntimeEvent extends RuntimeEvent {
  readonly registeredAt: string;
  readonly hostId: string;
  readonly vaultFingerprint: string;
}

export interface RuntimeEventAppendResult {
  readonly eventId: string;
  readonly inserted: boolean;
  readonly registeredAt: string;
}

export interface RuntimeEventReadOptions extends RuntimeLedgerOptions {
  /** Omit to return the complete retained history. */
  readonly limit?: number;
  readonly kinds?: readonly string[];
  readonly outcomes?: readonly RuntimeEventOutcome[];
  readonly surface?: string;
  readonly operation?: string;
}

export interface RuntimeEventReadResult {
  readonly events: readonly StoredRuntimeEvent[];
  /** True only when an explicit limit omitted additional matching rows. */
  readonly partial: boolean;
}

export type RuntimeLedgerErrorCode = "LEDGER_ROOT_INSIDE_VAULT" | "LEDGER_APPEND_FAILED";

export class RuntimeLedgerError extends Error {
  constructor(
    readonly code: RuntimeLedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RuntimeLedgerError";
  }
}
