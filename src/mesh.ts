/**
 * The mesh client: retries, deadline management, and failover on top of the
 * balancer and the raw HTTP/2 transport.
 *
 * Call loop per unary RPC:
 *   1. Pick an endpoint (excluding endpoints already tried in this call).
 *   2. Spend the remaining deadline on the attempt.
 *   3. On a retryable failure, back off and go to 1 — unless the call has
 *      already burned more than `deadlineGuardFraction` of its total
 *      deadline, in which case the last error is surfaced immediately.
 *   4. When nothing is pickable, throw the last real error immediately if
 *      failFast is set; otherwise wait out one backoff per remaining attempt
 *      (an ejection window may lapse) before surfacing the last error.
 */
import type { CallOptions, EndpointSpec, MeshEvent, MeshListener, MeshOptions } from "./types.js";
import { DEFAULT_BALANCER_OPTIONS, Balancer } from "./balancer.js";
import { DEFAULT_HEALTH_POLICY, HealthChecker, grpcHealthProbe } from "./health.js";
import { GrpcError, MeshError, GrpcStatus } from "./errors.js";
import { unaryCall } from "./grpc.js";

export const DEFAULT_RETRY_POLICY: MeshOptions["retry"] = {
  maxAttempts: 3,
  baseBackoffMs: 50,
  backoffMultiplier: 2,
  maxBackoffMs: 2_000,
  retryableStatuses: [GrpcStatus.UNAVAILABLE, GrpcStatus.CANCELED],
  deadlineGuardFraction: 0.8,
};

export const DEFAULT_MESH_OPTIONS: MeshOptions = {
  policy: "round_robin",
  retry: DEFAULT_RETRY_POLICY,
  health: DEFAULT_HEALTH_POLICY,
  defaultDeadlineMs: 10_000,
  failFast: false,
};

export interface MeshClientOptions extends Partial<MeshOptions> {
  endpoints: readonly EndpointSpec[];
  /** Injectable clock (ms) for deterministic tests. */
  clock?: () => number;
  /** Injectable sleep for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EndpointSnapshot {
  name: string;
  address: string;
  health: string;
  ejectedForMs: number;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  lastError: string | null;
}

export class MeshClient {
  private readonly balancer: Balancer;
  private readonly retry: MeshOptions["retry"];
  private readonly defaultDeadlineMs: number;
  private readonly failFast: boolean;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly listeners = new Set<MeshListener>();
  private readonly emitEvent: (event: MeshEvent) => void = (event) => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must never break the call loop */
      }
    }
  };
  private healthChecker: HealthChecker | null = null;
  private stopHealth: (() => void) | null = null;

  constructor(options: MeshClientOptions) {
    if (!Array.isArray(options.endpoints) || options.endpoints.length === 0) {
      throw new MeshError("NO_ENDPOINTS", "the mesh needs at least one endpoint");
    }
    const retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
      throw new MeshError("BAD_CONFIG", "retry.maxAttempts must be a positive integer");
    }
    if (retry.baseBackoffMs < 0 || retry.backoffMultiplier < 1 || retry.maxBackoffMs < retry.baseBackoffMs) {
      throw new MeshError("BAD_CONFIG", "backoff must satisfy 0 <= base, multiplier >= 1, max >= base");
    }
    if (!Number.isFinite(retry.deadlineGuardFraction) || retry.deadlineGuardFraction <= 0 || retry.deadlineGuardFraction > 1) {
      throw new MeshError("BAD_CONFIG", "deadlineGuardFraction must be in (0, 1]");
    }
    const defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_MESH_OPTIONS.defaultDeadlineMs;
    if (!Number.isFinite(defaultDeadlineMs) || defaultDeadlineMs <= 0) {
      throw new MeshError("BAD_CONFIG", "defaultDeadlineMs must be a positive finite number");
    }

    this.retry = retry;
    this.defaultDeadlineMs = defaultDeadlineMs;
    this.failFast = options.failFast ?? DEFAULT_MESH_OPTIONS.failFast;
    this.clock = options.clock ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => {
        if (ms <= 0) resolve();
        else setTimeout(resolve, ms).unref?.();
      }));

    this.balancer = new Balancer(
      options.endpoints,
      {
        policy: options.policy ?? DEFAULT_MESH_OPTIONS.policy,
        failuresToEject: DEFAULT_BALANCER_OPTIONS.failuresToEject,
        baseEjectionMs: DEFAULT_BALANCER_OPTIONS.baseEjectionMs,
        maxEjectionMs: DEFAULT_BALANCER_OPTIONS.maxEjectionMs,
      },
      this.clock,
      (event) => this.emitEvent(event),
    );

    const health = { ...DEFAULT_HEALTH_POLICY, ...options.health };
    if (health.intervalMs > 0) {
      this.healthChecker = new HealthChecker({
        endpoints: options.endpoints,
        policy: health,
        probe: grpcHealthProbe(health.timeoutMs),
        onHealthy: (name) => this.balancer.noteHealthy(name),
        onUnhealthy: (name, reason) => this.balancer.noteUnhealthy(name, reason),
      });
      this.stopHealth = this.healthChecker.start();
    }
  }

  on(listener: MeshListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Execute one unary RPC with load balancing, retries, and failover.
   * Resolves with the response message bytes; throws GrpcError/MeshError.
   */
  async call(method: string, request: Uint8Array, callOptions: CallOptions = {}): Promise<Uint8Array> {
    if (!method.startsWith("/")) {
      throw new MeshError("BAD_CONFIG", `method must look like "/package.Service/Method", got "${method}"`);
    }
    const totalDeadlineMs = callOptions.deadlineMs ?? this.defaultDeadlineMs;
    const maxAttempts = callOptions.maxAttempts ?? this.retry.maxAttempts;
    const startedAt = this.clock();
    const exclude = new Set<string>();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const elapsed = this.clock() - startedAt;
      if (attempt > 1 && elapsed >= totalDeadlineMs * this.retry.deadlineGuardFraction) break;

      const endpoint = this.balancer.pick(exclude);
      if (endpoint === null) {
        // Nothing left to try. Surface the real failure that got us here
        // instead of a generic "all unavailable" mask when we know the cause.
        if (lastError instanceof Error) {
          if (this.failFast || attempt >= maxAttempts) throw lastError;
          const waited = await this.waitOutBackoff(attempt, startedAt, totalDeadlineMs);
          if (waited) continue;
          throw lastError;
        }
        throw new MeshError("ALL_ENDPOINTS_UNAVAILABLE", "every endpoint is ejected, unhealthy, or excluded");
      }

      endpoint.stats.totalCalls += 1;
      const remaining = totalDeadlineMs - (this.clock() - startedAt);
      if (remaining <= 0) break;

      this.emitEvent({ type: "call-attempt", endpoint: endpoint.spec.name, attempt, method });

      try {
        const response = await unaryCall(
          endpoint.spec.address,
          method,
          request,
          {
          deadlineMs: remaining,
          ...(callOptions.metadata !== undefined ? { metadata: callOptions.metadata } : {}),
        },
        );
        if (response.status === GrpcStatus.OK) {
          this.balancer.reportSuccess(endpoint);
          return response.message;
        }
        // Server answered with a non-OK grpc-status in the trailers.
        const reason = response.statusMessage ?? `status ${response.status}`;
        this.balancer.reportFailure(endpoint, reason);
        lastError = new GrpcError(response.status, reason, endpoint.spec.name);
        if (!this.retry.retryableStatuses.includes(response.status)) break;
        this.emitEvent({ type: "call-retry", endpoint: endpoint.spec.name, attempt, status: response.status, reason });
      } catch (err) {
        this.balancer.reportFailure(endpoint, err instanceof Error ? err.message : String(err));
        lastError = err;
        const status = err instanceof GrpcError ? err.status : GrpcStatus.UNAVAILABLE;
        if (!this.retry.retryableStatuses.includes(status)) break;
        this.emitEvent({ type: "call-retry", endpoint: endpoint.spec.name, attempt, status, reason: err instanceof Error ? err.message : String(err) });
      }

      exclude.add(endpoint.spec.name);
      if (attempt < maxAttempts) {
        const waited = await this.waitOutBackoff(attempt, startedAt, totalDeadlineMs);
        if (!waited) break;
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new MeshError("DEADLINE_EXCEEDED", `call to ${method} exhausted its ${totalDeadlineMs}ms deadline`);
  }

  /** Sleep one backoff step; returns false when the deadline gives out first. */
  private async waitOutBackoff(attempt: number, startedAt: number, totalDeadlineMs: number): Promise<boolean> {
    const backoff = Math.min(
      this.retry.baseBackoffMs * this.retry.backoffMultiplier ** (attempt - 1),
      this.retry.maxBackoffMs,
    );
    const remaining = totalDeadlineMs - (this.clock() - startedAt);
    if (remaining <= 0) return false;
    await this.sleep(Math.min(backoff, remaining));
    // The attempt loop's own deadline guard decides whether another attempt
    // may start; returning true just means the sleep itself did not blow the
    // total deadline.
    return this.clock() - startedAt < totalDeadlineMs;
  }

  /** Per-endpoint operational snapshot. */
  stats(): EndpointSnapshot[] {
    return this.balancer.snapshot().map((s) => ({
      name: s.name,
      address: s.address,
      health: s.health,
      ejectedForMs: s.ejectedForMs,
      totalCalls: s.stats.totalCalls,
      successfulCalls: s.stats.successfulCalls,
      failedCalls: s.stats.failedCalls,
      lastError: s.stats.lastError,
    }));
  }

  /** Stop background health checking. The client stays usable for manual calls. */
  close(): void {
    this.stopHealth?.();
    this.stopHealth = null;
    this.listeners.clear();
  }
}
