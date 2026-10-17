/**
 * Endpoint selection, failure-driven circuit breaking, and weighted
 * round-robin (the nginx "smooth weighted round-robin" algorithm).
 *
 * Failure model (passive circuit breaker):
 *   - `consecutiveFailures` accumulates on every failed call and resets on
 *     any success.
 *   - At `failuresToEject` consecutive failures the endpoint is ejected for
 *     `min(baseEjectionMs * 2^(ejectionIndex), maxEjectionMs)` — the window
 *     grows exponentially with each repeat ejection.
 *   - When the window lapses the endpoint becomes pickable again
 *     ("half-open"): the next call is effectively a probe. Success resets
 *     the breaker; failure ejects it again with a doubled window.
 *   - Endpoints marked unhealthy by the active health checker are never
 *     picked; `noteHealthy` restores them.
 */
import type { EndpointSpec, EndpointState, EndpointStats, LoadBalancingPolicy, MeshListener } from "./types.js";
import { MeshError } from "./errors.js";

export interface BalancerOptions {
  policy: LoadBalancingPolicy;
  /** Consecutive failures before an endpoint is ejected. */
  failuresToEject: number;
  /** First ejection window (ms); doubles per repeat ejection. */
  baseEjectionMs: number;
  /** Upper bound on any single ejection window (ms). */
  maxEjectionMs: number;
}

export const DEFAULT_BALANCER_OPTIONS: BalancerOptions = {
  policy: "round_robin",
  failuresToEject: 3,
  baseEjectionMs: 1_000,
  maxEjectionMs: 30_000,
};

export interface BalancerEndpointSnapshot {
  name: string;
  address: string;
  health: EndpointState["health"];
  ejectedForMs: number;
  stats: EndpointStats;
}

export class Balancer {
  readonly endpoints: EndpointState[];

  private readonly options: BalancerOptions;
  private readonly clock: () => number;
  private readonly emit: MeshListener;
  /** Smooth weighted round-robin current weights, keyed by endpoint name. */
  private readonly currentWeights = new Map<string, number>();
  /** How many times each endpoint has been ejected (drives window growth). */
  private readonly ejectionIndex = new Map<string, number>();

  constructor(
    specs: readonly EndpointSpec[],
    options: BalancerOptions,
    clock: () => number = Date.now,
    emit: MeshListener = () => {},
  ) {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new MeshError("NO_ENDPOINTS", "the balancer needs at least one endpoint");
    }
    if (options.failuresToEject < 1) {
      throw new MeshError("BAD_CONFIG", "failuresToEject must be >= 1");
    }
    if (options.baseEjectionMs <= 0 || options.maxEjectionMs < options.baseEjectionMs) {
      throw new MeshError("BAD_CONFIG", "ejection windows must satisfy 0 < base <= max");
    }

    const seen = new Set<string>();
    for (const spec of specs) {
      if (!spec.name || seen.has(spec.name)) {
        throw new MeshError("BAD_CONFIG", `endpoint names must be non-empty and unique, got "${spec.name}"`);
      }
      seen.add(spec.name);
      if (!/^[^:\s]+:\d+$/.test(spec.address)) {
        throw new MeshError("BAD_CONFIG", `endpoint "${spec.name}" address must be "host:port", got "${spec.address}"`);
      }
      const weight = spec.weight ?? 1;
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new MeshError("BAD_CONFIG", `endpoint "${spec.name}" weight must be a positive number, got ${weight}`);
      }
    }

    this.endpoints = specs.map((spec) => ({
      spec,
      health: "unknown" as const,
      consecutiveFailures: 0,
      ejectedUntil: 0,
      probing: false,
      privateCursor: 0,
      stats: { totalCalls: 0, successfulCalls: 0, failedCalls: 0, lastError: null, lastUsedAt: 0 },
    }));
    this.options = { ...options };
    this.clock = clock;
    this.emit = emit;
  }

  /**
   * Pick the next endpoint, skipping excluded, ejected, and unhealthy ones.
   * Returns null when nothing is eligible.
   */
  pick(exclude: ReadonlySet<string> = new Set()): EndpointState | null {
    const now = this.clock();
    const eligible = this.endpoints.filter(
      (e) => !exclude.has(e.spec.name) && e.ejectedUntil <= now && e.health !== "unhealthy",
    );
    for (const e of this.endpoints) {
      if (!eligible.includes(e)) this.currentWeights.set(e.spec.name, 0);
    }
    if (eligible.length === 0) return null;
    if (this.options.policy === "pick_first") return eligible[0]!;

    // Smooth weighted round-robin: raise each eligible endpoint by its
    // weight, pick the highest, then lower the winner by the total weight.
    let totalWeight = 0;
    let best: EndpointState | null = null;
    let bestWeight = -Infinity;
    for (const e of eligible) {
      const weight = e.spec.weight ?? 1;
      totalWeight += weight;
      const current = (this.currentWeights.get(e.spec.name) ?? 0) + weight;
      this.currentWeights.set(e.spec.name, current);
      if (current > bestWeight) {
        best = e;
        bestWeight = current;
      }
    }
    const winner = best!;
    this.currentWeights.set(winner.spec.name, (this.currentWeights.get(winner.spec.name) ?? 0) - totalWeight);
    return winner;
  }

  /** Record a successful call: resets the breaker and failure streak. */
  reportSuccess(endpoint: EndpointState): void {
    endpoint.consecutiveFailures = 0;
    endpoint.health = "healthy";
    endpoint.probing = false;
    this.ejectionIndex.set(endpoint.spec.name, 0);
    endpoint.stats.successfulCalls += 1;
    endpoint.stats.lastError = null;
  }

  /** Record a failed call; may eject the endpoint (circuit opens). */
  reportFailure(endpoint: EndpointState, reason: string): void {
    endpoint.stats.failedCalls += 1;
    endpoint.stats.lastError = reason;
    endpoint.consecutiveFailures += 1;
    // Half-open probe: an endpoint whose ejection window just lapsed is on
    // probation — its first new failure re-ejects it immediately.
    const now = this.clock();
    const failedProbe = endpoint.ejectedUntil > 0 && endpoint.ejectedUntil <= now;
    if (endpoint.consecutiveFailures < this.options.failuresToEject && !failedProbe) return;

    const index = this.ejectionIndex.get(endpoint.spec.name) ?? 0;
    const window = Math.min(this.options.baseEjectionMs * 2 ** index, this.options.maxEjectionMs);
    endpoint.ejectedUntil = this.clock() + window;
    endpoint.probing = false;
    this.ejectionIndex.set(endpoint.spec.name, index + 1);
    endpoint.consecutiveFailures = 0;
    this.emit({ type: "endpoint-ejected", endpoint: endpoint.spec.name, until: window });
  }

  /** Called by the active health checker when a probe succeeds. */
  noteHealthy(name: string): void {
    const endpoint = this.find(name);
    if (endpoint === null || endpoint.health === "healthy") return;
    endpoint.health = "healthy";
    endpoint.consecutiveFailures = 0;
    this.ejectionIndex.set(name, 0);
    this.emit({ type: "endpoint-up", endpoint: name });
  }

  /** Called by the active health checker when a probe fails. */
  noteUnhealthy(name: string, reason: string): void {
    const endpoint = this.find(name);
    if (endpoint === null || endpoint.health === "unhealthy") return;
    endpoint.health = "unhealthy";
    endpoint.stats.lastError = reason;
    this.emit({ type: "endpoint-down", endpoint: name, reason });
  }

  /** Point-in-time operational snapshot of every endpoint. */
  snapshot(): BalancerEndpointSnapshot[] {
    const now = this.clock();
    return this.endpoints.map((e) => ({
      name: e.spec.name,
      address: e.spec.address,
      health: e.health,
      ejectedForMs: Math.max(0, e.ejectedUntil - now),
      stats: { ...e.stats },
    }));
  }

  private find(name: string): EndpointState | null {
    return this.endpoints.find((e) => e.spec.name === name) ?? null;
  }
}
