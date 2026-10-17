import { describe, test, expect, afterEach } from "bun:test";
import { MeshClient } from "../src/mesh.js";
import { startMeshServer, echoHandler, failingHandler, ECHO_METHOD } from "../src/server.js";
import { writer, decodeMessage, fieldString } from "../src/protobuf.js";
import { GrpcError, GrpcStatus, MeshError } from "../src/index.js";
import type { RunningMeshServer } from "../src/server.js";
import type { MeshEvent } from "../src/types.js";

const liveServers: RunningMeshServer[] = [];

afterEach(async () => {
  while (liveServers.length > 0) {
    await liveServers.pop()!.close();
  }
});

async function spawnServer(handler: ReturnType<typeof echoHandler> | ReturnType<typeof failingHandler>, healthy = () => true) {
  const server = await startMeshServer({ handlers: { [ECHO_METHOD]: handler }, healthy });
  liveServers.push(server);
  return server;
}

function echoRequest(message: string): Uint8Array {
  const w = writer();
  w.string(1, message);
  return w.toBytes();
}

function echoText(bytes: Uint8Array): string {
  return fieldString(findFirst(decodeMessage(bytes)));
}

function findFirst(fields: ReturnType<typeof decodeMessage>) {
  const f = fields.find((x) => x.field === 1);
  if (f === undefined) throw new Error("missing field 1");
  return f;
}

const FAST_RETRY = {
  maxAttempts: 4,
  baseBackoffMs: 1,
  backoffMultiplier: 1,
  maxBackoffMs: 5,
  retryableStatuses: [GrpcStatus.UNAVAILABLE, GrpcStatus.CANCELED],
  deadlineGuardFraction: 0.8,
};

describe("MeshClient (real HTTP/2 servers)", () => {
  test("happy path: a unary call round-trips through the mesh", async () => {
    const server = await spawnServer(echoHandler("echo"));
    const client = new MeshClient({
      endpoints: [{ name: "only", address: `127.0.0.1:${server.port}` }],
      retry: FAST_RETRY,
    });
    try {
      const reply = await client.call(ECHO_METHOD, echoRequest("hello mesh"));
      expect(echoText(reply)).toBe("echo: hello mesh");
      const stats = client.stats()[0]!;
      expect(stats.successfulCalls).toBe(1);
      expect(stats.failedCalls).toBe(0);
    } finally {
      client.close();
    }
  });

  test("failover: a failing endpoint is retried on a healthy one in the same call", async () => {
    // bad is listed first so the first attempt lands on it and the retry
    // fails over to the healthy endpoint within the same call.
    const bad = await spawnServer(failingHandler(GrpcStatus.UNAVAILABLE, "down for maintenance"));
    const good = await spawnServer(echoHandler("good"));
    const client = new MeshClient({
      endpoints: [
        { name: "bad", address: `127.0.0.1:${bad.port}` },
        { name: "good", address: `127.0.0.1:${good.port}` },
      ],
      policy: "round_robin",
      retry: FAST_RETRY,
    });
    const events: MeshEvent[] = [];
    client.on((e) => events.push(e));
    try {
      const reply = await client.call(ECHO_METHOD, echoRequest("r"));
      expect(echoText(reply)).toBe("good: r");
      expect(events.some((e) => e.type === "call-retry")).toBe(true);
    } finally {
      client.close();
    }
  });

  test("passive circuit breaker: repeated failures eject the endpoint", async () => {
    const good = await spawnServer(echoHandler("good"));
    const bad = await spawnServer(failingHandler(GrpcStatus.UNAVAILABLE, "still down"));
    const client = new MeshClient({
      endpoints: [
        { name: "good", address: `127.0.0.1:${good.port}` },
        { name: "bad", address: `127.0.0.1:${bad.port}` },
      ],
      policy: "round_robin",
      retry: FAST_RETRY,
    });
    try {
      // Smooth weighted round-robin over two equal endpoints alternates
      // good/bad; the bad endpoint is hit on calls 2, 4, and 6, and its third
      // consecutive failure ejects it.
      for (let i = 1; i <= 6; i += 1) {
        const reply = await client.call(ECHO_METHOD, echoRequest(`c${i}`));
        expect(echoText(reply)).toBe("good: c" + i);
      }
      const stats = client.stats();
      const badStats = stats.find((s) => s.name === "bad")!;
      expect(badStats.failedCalls).toBe(3);
      expect(stats.find((s) => s.name === "good")!.successfulCalls).toBe(6);
      expect(badStats.ejectedForMs).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  test("non-retryable statuses surface immediately without a second attempt", async () => {
    const bad = await spawnServer(failingHandler(GrpcStatus.INVALID_ARGUMENT, "bad input"));
    const client = new MeshClient({
      endpoints: [{ name: "bad", address: `127.0.0.1:${bad.port}` }],
      retry: FAST_RETRY,
    });
    const events: MeshEvent[] = [];
    client.on((e) => events.push(e));
    try {
      await expect(client.call(ECHO_METHOD, echoRequest("x"))).rejects.toThrow(GrpcError);
      expect(events.filter((e) => e.type === "call-retry").length).toBe(0);
    } finally {
      client.close();
    }
  });

  test("deadline exceeded when the handler overruns the call deadline", async () => {
    const slow = await spawnServer(async () => {
      await new Promise((r) => setTimeout(r, 500));
      const w = writer();
      w.string(1, "too late");
      return w.toBytes();
    });
    const client = new MeshClient({
      endpoints: [{ name: "slow", address: `127.0.0.1:${slow.port}` }],
      retry: { ...FAST_RETRY, maxAttempts: 1 },
    });
    try {
      await expect(client.call(ECHO_METHOD, echoRequest("x"), { deadlineMs: 100 })).rejects.toThrow(/DEADLINE_EXCEEDED|deadline/);
    } finally {
      client.close();
    }
  });

  test("unimplemented methods return status 12", async () => {
    const server = await spawnServer(echoHandler("echo"));
    const client = new MeshClient({
      endpoints: [{ name: "s", address: `127.0.0.1:${server.port}` }],
      retry: FAST_RETRY,
    });
    try {
      await expect(client.call("/no.Such/Method", echoRequest("x"))).rejects.toThrow(GrpcError);
      try {
        await client.call("/no.Such/Method", echoRequest("x"));
      } catch (err) {
        expect((err as GrpcError).status).toBe(GrpcStatus.UNIMPLEMENTED);
      }
    } finally {
      client.close();
    }
  });

  test("failFast: the last real error surfaces while retries remain meaningful", async () => {
    const bad = await spawnServer(failingHandler(GrpcStatus.UNAVAILABLE, "down"));
    const client = new MeshClient({
      endpoints: [{ name: "bad", address: `127.0.0.1:${bad.port}` }],
      retry: FAST_RETRY,
      failFast: true,
    });
    try {
      // Each call: attempt 1 fails, attempt 2 finds nothing pickable → the
      // original UNAVAILABLE error is surfaced, not a generic mask.
      for (let i = 0; i < 3; i += 1) {
        await expect(client.call(ECHO_METHOD, echoRequest("x"))).rejects.toThrow(GrpcError);
      }
      // Third failure ejected the endpoint → nothing was ever pickable → the
      // dedicated ALL_ENDPOINTS_UNAVAILABLE error.
      await expect(client.call(ECHO_METHOD, echoRequest("x"))).rejects.toThrow(MeshError);
      const stats = client.stats()[0]!;
      expect(stats.failedCalls).toBe(3);
      expect(stats.ejectedForMs).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  test("without failFast, exhausted retries surface the original error", async () => {
    const bad = await spawnServer(failingHandler(GrpcStatus.UNAVAILABLE, "down"));
    const client = new MeshClient({
      endpoints: [{ name: "bad", address: `127.0.0.1:${bad.port}` }],
      retry: { ...FAST_RETRY, maxAttempts: 2 },
      failFast: false,
    });
    try {
      await expect(client.call(ECHO_METHOD, echoRequest("x"))).rejects.toThrow(GrpcError);
    } finally {
      client.close();
    }
  });

  test("constructor validates configuration", () => {
    expect(() => new MeshClient({ endpoints: [] })).toThrow(MeshError);
    expect(
      () =>
        new MeshClient({
          endpoints: [{ name: "a", address: "127.0.0.1:1" }],
          retry: { ...FAST_RETRY, maxAttempts: 0 },
        }),
    ).toThrow(/maxAttempts/);
    expect(
      () =>
        new MeshClient({
          endpoints: [{ name: "a", address: "127.0.0.1:1" }],
          retry: { ...FAST_RETRY, deadlineGuardFraction: 0 },
        }),
    ).toThrow(/deadlineGuardFraction/);
  });
});
