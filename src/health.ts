/**
 * Active health checking against the standard gRPC health protocol
 * (grpc.health.v1.Health/Check).
 *
 * The checker is policy-driven: `failuresToUnhealthy` consecutive failed
 * probes mark an endpoint unhealthy, `successesToHealthy` consecutive good
 * probes mark it healthy again. A zero `intervalMs` disables background
 * checking entirely — `checkAll()` can still be driven manually (which is
 * exactly how the tests and one-shot users exercise it).
 */
import type { EndpointSpec, HealthCheckPolicy } from "./types.js";
import { decodeMessage, fieldVarint, findField, writer } from "./protobuf.js";
import { HEALTH_CHECK_PATH, HEALTH_SERVING, unaryCall } from "./grpc.js";

export const DEFAULT_HEALTH_POLICY: HealthCheckPolicy = {
  intervalMs: 0,
  timeoutMs: 500,
  failuresToUnhealthy: 2,
  successesToHealthy: 1,
  serviceName: "",
};

export type HealthProbe = (address: string, serviceName: string) => Promise<boolean>;

export interface HealthCheckerOptions {
  endpoints: readonly EndpointSpec[];
  policy: HealthCheckPolicy;
  /** Probe one endpoint; resolves true when it should be considered serving. */
  probe: HealthProbe;
  onHealthy?: (endpointName: string) => void;
  onUnhealthy?: (endpointName: string, reason: string) => void;
}

interface EndpointHealthState {
  streakFailures: number;
  streakSuccesses: number;
  health: "unknown" | "healthy" | "unhealthy";
}

export class HealthChecker {
  private readonly endpoints: readonly EndpointSpec[];
  private readonly policy: HealthCheckPolicy;
  private readonly probe: HealthProbe;
  private readonly onHealthy: ((endpointName: string) => void) | undefined;
  private readonly onUnhealthy: ((endpointName: string, reason: string) => void) | undefined;
  private readonly states = new Map<string, EndpointHealthState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private round = 0;

  constructor(options: HealthCheckerOptions) {
    if (options.policy.intervalMs < 0) {
      throw new Error("health.intervalMs must be >= 0");
    }
    if (options.policy.failuresToUnhealthy < 1 || options.policy.successesToHealthy < 1) {
      throw new Error("health thresholds must be >= 1");
    }
    const names = new Set<string>();
    for (const spec of options.endpoints) {
      if (!spec.name || names.has(spec.name)) throw new Error(`endpoint names must be non-empty and unique, got "${spec.name}"`);
      names.add(spec.name);
    }
    this.endpoints = options.endpoints;
    this.policy = options.policy;
    this.probe = options.probe;
    this.onHealthy = options.onHealthy;
    this.onUnhealthy = options.onUnhealthy;
    for (const spec of options.endpoints) {
      this.states.set(spec.name, { streakFailures: 0, streakSuccesses: 0, health: "unknown" });
    }
  }

  /** Start the background interval; returns a stop function (idempotent). */
  start(): () => void {
    if (this.timer !== null) return () => this.stop();
    this.timer = setInterval(() => {
      void this.checkAll().catch(() => {
        /* a failed round is just a failed round; the next one will retry */
      });
    }, this.policy.intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one full probe round across every endpoint. */
  async checkAll(): Promise<void> {
    this.round += 1;
    await Promise.all(this.endpoints.map((spec) => this.checkOne(spec)));
  }

  /** Current health view: endpoint name → health. */
  statesMap(): Record<string, "unknown" | "healthy" | "unhealthy"> {
    const out: Record<string, "unknown" | "healthy" | "unhealthy"> = {};
    for (const [name, state] of this.states) out[name] = state.health;
    return out;
  }

  /** Number of completed probe rounds (exposed for tests/diagnostics). */
  rounds(): number {
    return this.round;
  }

  private async checkOne(spec: EndpointSpec): Promise<void> {
    const state = this.states.get(spec.name);
    if (state === undefined) return;
    let healthy: boolean;
    try {
      healthy = await this.probe(spec.address, this.policy.serviceName);
    } catch {
      healthy = false;
    }

    if (healthy) {
      state.streakFailures = 0;
      state.streakSuccesses += 1;
      if (state.health !== "healthy" && state.streakSuccesses >= this.policy.successesToHealthy) {
        state.health = "healthy";
        this.onHealthy?.(spec.name);
      }
      return;
    }

    state.streakSuccesses = 0;
    state.streakFailures += 1;
    if (state.health !== "unhealthy" && state.streakFailures >= this.policy.failuresToUnhealthy) {
      state.health = "unhealthy";
      this.onUnhealthy?.(spec.name, `health check failed ${state.streakFailures} consecutive time(s)`);
    }
  }
}

/**
 * Default probe: a real unary call to grpc.health.v1.Health/Check.
 * SERVING (1) is healthy; anything else — non-SERVING status, non-OK gRPC
 * status, transport error — is unhealthy.
 */
export function grpcHealthProbe(timeoutMs: number): HealthProbe {
  return async (address, serviceName) => {
    const w = writer();
    if (serviceName !== "") w.string(1, serviceName);
    const response = await unaryCall(address, HEALTH_CHECK_PATH, w.toBytes(), { deadlineMs: timeoutMs });
    const fields = decodeMessage(response.message);
    const statusField = findField(fields, 1);
    return statusField !== undefined && fieldVarint(statusField) === BigInt(HEALTH_SERVING);
  };
}

