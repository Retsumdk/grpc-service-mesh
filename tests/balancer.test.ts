import { describe, test, expect } from "bun:test";
import { Balancer, DEFAULT_BALANCER_OPTIONS } from "../src/balancer.js";
import { MeshError } from "../src/errors.js";
import type { EndpointSpec, MeshEvent } from "../src/types.js";

function specs(names: string[], weights?: number[]): EndpointSpec[] {
  return names.map((name, i) => {
    const spec: { name: string; address: string; weight?: number } = { name, address: `127.0.0.1:${5000 + i}` };
    if (weights !== undefined) spec.weight = weights[i]!;
    return spec;
  });
}

function makeBalancer(specList: EndpointSpec[], overrides: Partial<typeof DEFAULT_BALANCER_OPTIONS> = {}) {
  let now = 0;
  const events: MeshEvent[] = [];
  const balancer = new Balancer(
    specList,
    { ...DEFAULT_BALANCER_OPTIONS, ...overrides },
    () => now,
    (event) => events.push(event),
  );
  return {
    balancer,
    events,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("Balancer", () => {
  test("smooth weighted round-robin distributes 3:1 without runs longer than 2", () => {
    const { balancer } = makeBalancer(specs(["a", "b"], [3, 1]));
    const picks = Array.from({ length: 8 }, () => balancer.pick()!.spec.name);
    // Smooth WRR guarantees exact proportional share (6a / 2b per 8 picks),
    // spreads the heavier endpoint out (no 3-in-a-row runs), and is periodic.
    expect(picks.filter((n) => n === "a").length).toBe(6);
    expect(picks.filter((n) => n === "b").length).toBe(2);
    let run = 1;
    for (let i = 1; i < picks.length; i += 1) {
      run = picks[i] === picks[i - 1] ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(3);
    }
    // The schedule repeats every totalWeight picks.
    expect(picks.slice(0, 4)).toEqual(picks.slice(4, 8));
  });

  test("equal weights alternate", () => {
    const { balancer } = makeBalancer(specs(["a", "b"]));
    const picks = Array.from({ length: 6 }, () => balancer.pick()!.spec.name);
    expect(picks.join(",")).toBe("a,b,a,b,a,b");
  });

  test("pick_first always returns the first eligible endpoint", () => {
    const { balancer } = makeBalancer(specs(["a", "b", "c"]), { policy: "pick_first" });
    expect(balancer.pick()!.spec.name).toBe("a");
    expect(balancer.pick()!.spec.name).toBe("a");
  });

  test("excluded endpoints are skipped", () => {
    const { balancer } = makeBalancer(specs(["a", "b", "c"]));
    expect(balancer.pick(new Set(["a"]))!.spec.name).toBe("b");
    expect(balancer.pick(new Set(["a", "b"]))!.spec.name).toBe("c");
    expect(balancer.pick(new Set(["a", "b", "c"]))).toBeNull();
  });

  test("ejects after failuresToEject consecutive failures and recovers after the window", () => {
    const { balancer, events, advance } = makeBalancer(specs(["a", "b"]), { failuresToEject: 2, baseEjectionMs: 100 });
    const b = balancer.endpoints.find((e) => e.spec.name === "b")!;

    balancer.reportFailure(b, "boom 1");
    expect(b.ejectedUntil).toBe(0);
    balancer.reportFailure(b, "boom 2");
    expect(b.ejectedUntil).toBe(100);
    expect(events.filter((e) => e.type === "endpoint-ejected").length).toBe(1);
    // Still ejected within the window.
    advance(50);
    expect(balancer.pick(new Set(["a"]))).toBeNull();
    // Window lapses → pickable again (half-open).
    advance(50);
    const recovered = balancer.pick(new Set(["a"]));
    expect(recovered?.spec.name).toBe("b");
    // Probe failure re-ejects with a doubled window, immediately.
    balancer.reportFailure(recovered!, "probe failed");
    expect(balancer.pick(new Set(["a"]))).toBeNull();
    advance(199);
    expect(balancer.pick(new Set(["a"]))).toBeNull();
    advance(1);
    expect(balancer.pick(new Set(["a"]))?.spec.name).toBe("b");
  });

  test("a success resets the failure streak and marks the endpoint healthy", () => {
    const { balancer, events } = makeBalancer(specs(["a"]), { failuresToEject: 2 });
    const a = balancer.endpoints[0]!;
    balancer.reportFailure(a, "x");
    balancer.reportSuccess(a);
    expect(a.consecutiveFailures).toBe(0);
    expect(a.health).toBe("healthy");
    balancer.reportFailure(a, "y");
    // Streak restarted, so no ejection yet.
    expect(a.ejectedUntil).toBe(0);
    expect(events.filter((e) => e.type === "endpoint-ejected").length).toBe(0);
  });

  test("noteUnhealthy removes the endpoint from selection until noteHealthy", () => {
    const { balancer, events } = makeBalancer(specs(["a", "b"]));
    balancer.noteUnhealthy("a", "probes failing");
    expect(balancer.pick()!.spec.name).toBe("b");
    expect(events.filter((e) => e.type === "endpoint-down").length).toBe(1);
    balancer.noteHealthy("a");
    expect(balancer.pick()!.spec.name).toBe("a");
    expect(events.filter((e) => e.type === "endpoint-up").length).toBe(1);
  });

  test("snapshot reports remaining ejection time", () => {
    const { balancer, advance } = makeBalancer(specs(["a"]), { failuresToEject: 1, baseEjectionMs: 500 });
    const a = balancer.endpoints[0]!;
    balancer.reportFailure(a, "dead");
    advance(200);
    const snap = balancer.snapshot()[0]!;
    expect(snap.ejectedForMs).toBe(300);
  });

  test("rejects duplicate names, bad addresses, and bad weights", () => {
    expect(() => new Balancer(specs(["a", "a"]), DEFAULT_BALANCER_OPTIONS)).toThrow(MeshError);
    expect(
      () =>
        new Balancer([{ name: "a", address: "no-port" }], DEFAULT_BALANCER_OPTIONS),
    ).toThrow(MeshError);
    expect(
      () =>
        new Balancer([{ name: "a", address: "h:1", weight: 0 }], DEFAULT_BALANCER_OPTIONS),
    ).toThrow(MeshError);
    expect(() => new Balancer([], DEFAULT_BALANCER_OPTIONS)).toThrow(MeshError);
  });
});
