/**
 * Public types for grpc-service-mesh.
 */

/** A single backend endpoint the mesh may route to. */
export interface EndpointSpec {
  /** Stable identifier used in logs, events, and balancer bookkeeping. */
  readonly name: string;
  /** Dial target in `host:port` form. */
  readonly address: string;
  /** Optional per-endpoint weight for weighted round-robin. Default 1. */
  readonly weight?: number;
}

/** Runtime state of one endpoint, owned by the balancer. */
export type EndpointHealth = "unknown" | "healthy" | "unhealthy";

export interface EndpointState {
  readonly spec: EndpointSpec;
  health: EndpointHealth;
  /** Consecutive failed calls; reset on any success. */
  consecutiveFailures: number;
  /** Timestamp (ms) until which the endpoint is ejected, 0 = never. */
  ejectedUntil: number;
  /** Half-open probe in flight (circuit breaker). */
  probing: boolean;
  /** Round-robin cursor within a weighted endpoint. */
  privateCursor: number;
  readonly stats: EndpointStats;
}

export interface EndpointStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  lastError: string | null;
  lastUsedAt: number;
}

export type LoadBalancingPolicy = "round_robin" | "pick_first";

export interface RetryPolicy {
  /** Total attempts including the first (must be >= 1). */
  maxAttempts: number;
  baseBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  /** gRPC status codes worth retrying on a fresh connection. */
  retryableStatuses: readonly number[];
  /** Never retry a call that already consumed more than this fraction of its deadline. */
  deadlineGuardFraction: number;
}

export interface HealthCheckPolicy {
  /** Interval between active health checks (ms). 0 disables. */
  intervalMs: number;
  /** Dial deadline per health check (ms). */
  timeoutMs: number;
  /** Failures before an endpoint is marked unhealthy (0 marks immediately). */
  failuresToUnhealthy: number;
  /** Successes needed to flip an unhealthy endpoint back to healthy. */
  successesToHealthy: number;
  /** gRPC health service name sent in the check ("" = whole server). */
  serviceName: string;
}

export interface MeshOptions {
  policy: LoadBalancingPolicy;
  retry: RetryPolicy;
  health: HealthCheckPolicy;
  /** Per-call default deadline (ms) when the caller does not pass one. */
  defaultDeadlineMs: number;
  /** Fail the whole call when every endpoint is ejected/unhealthy. */
  failFast: boolean;
}

export interface CallOptions {
  deadlineMs?: number;
  /** Per-call retry override; total attempts including the first. */
  maxAttempts?: number;
  metadata?: Readonly<Record<string, string>>;
}

/** A unary gRPC handler: request bytes in, response bytes out. */
export type UnaryHandler = (request: Uint8Array, context: CallContext) => Promise<Uint8Array> | Uint8Array;

export interface CallContext {
  readonly method: string;
  readonly address: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type MeshEvent =
  | { type: "endpoint-down"; endpoint: string; reason: string }
  | { type: "endpoint-up"; endpoint: string }
  | { type: "call-attempt"; endpoint: string; attempt: number; method: string }
  | { type: "call-retry"; endpoint: string; attempt: number; status: number; reason: string }
  | { type: "endpoint-ejected"; endpoint: string; until: number };

export type MeshListener = (event: MeshEvent) => void;
