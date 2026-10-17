/** Canonical gRPC status codes (https://grpc.io/docs/guides/status-codes/). */
export const GrpcStatus = {
  OK: 0,
  CANCELED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export type GrpcStatusCode = (typeof GrpcStatus)[keyof typeof GrpcStatus];

const STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "OK",
  1: "CANCELED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

export function statusName(code: number): string {
  return STATUS_NAMES[code] ?? `UNKNOWN_STATUS_${code}`;
}

export class MeshError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MeshError";
    this.code = code;
  }
}

export type MeshErrorCode =
  | "NO_ENDPOINTS"
  | "ALL_ENDPOINTS_UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "CIRCUIT_OPEN"
  | "BAD_ADDRESS"
  | "BAD_CONFIG"
  | "BAD_FRAME"
  | "SERVER_ERROR"
  | "UNSUPPORTED";

/** A failed gRPC call carrying the canonical status code and message. */
export class GrpcError extends Error {
  readonly status: number;
  readonly endpoint: string | null;

  constructor(status: number, message: string, endpoint: string | null = null) {
    super(`gRPC status ${status} (${statusName(status)}): ${message}`);
    this.name = "GrpcError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Thrown by handlers to surface a specific gRPC status to the caller. */
export function grpcFailure(status: number, message: string): GrpcError {
  return new GrpcError(status, message, null);
}

/** Map transport-layer surprises onto sane gRPC statuses. */
export function statusForTransportError(err: unknown): number {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ETIMEDOUT" || code === "ENG_DEADLINE") return GrpcStatus.DEADLINE_EXCEEDED;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
    return GrpcStatus.UNAVAILABLE;
  }
  return GrpcStatus.UNAVAILABLE;
}
