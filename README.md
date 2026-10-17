# grpc-service-mesh

A zero-dependency gRPC service mesh for unary calls in TypeScript: real HTTP/2 gRPC wire protocol, a hand-rolled protobuf wire codec, weighted round-robin load balancing, deadline-aware retries with exponential backoff, a passive circuit breaker with half-open recovery, and standard gRPC health checking.

## The problem

Pointing a client at a single gRPC address couples it to that endpoint's uptime, capacity, and network path. Real deployments need the things gRPC core libraries hide behind language-specific "channels": pick among several backends, shed traffic away from the ones that are failing or unhealthy, retry within a hard deadline without retrying past it, and surface every decision as an event you can log. The official `grpc` npm package pulls in a native C-core binary; many teams running plain Node or Bun services want none of that.

## How this solves it

`grpc-service-mesh` implements the client-side mesh pattern directly on `node:http2`:

- **Wire protocol** — every message is a real gRPC frame (`1-byte compression flag + 4-byte big-endian length + payload`) on an HTTP/2 stream with `content-type: application/grpc+proto`, `te: trailers`, and `grpc-timeout`. Status travels in trailers per the gRPC spec, with a trailers-only fallback for bodyless responses.
- **Protobuf codec** — a small encoder/decoder for the wire types unary services actually use (varint, length-delimited, fixed32/64), so demo and example services run without code generation. Any codec works at the library level: handlers and calls speak raw `Uint8Array`.
- **Load balancing** — nginx-style *smooth weighted round-robin* (a 3:1 spread interleaves as `a,b,a,a` rather than `a,a,a,b`) or `pick_first`.
- **Retries** — per-call attempt budget, exponential backoff with a cap, retryable status codes, and a *deadline guard*: the loop refuses to start a new attempt once the call has burned more than `deadlineGuardFraction` of its total deadline, so retries never silently extend a deadline.
- **Circuit breaker** — `failuresToEject` consecutive failures eject an endpoint for a window that doubles on repeat ejections; when the window lapses the endpoint is on half-open probation (one more failure re-ejects it, a success resets it).
- **Health checking** — active probes against the standard `grpc.health.v1.Health/Check` service flip endpoints out of and back into rotation on consecutive failure/success streaks.
- **Events** — every pick, retry, ejection, up, and down is emitted as a typed event for logging and metrics.

```
MeshClient.call(method, request)
   │
   ▼
Balancer.pick()            weighted round-robin / pick_first,
   │                       skips ejected + unhealthy endpoints
   ▼
unaryCall(address, …)      HTTP/2 → gRPC frame → protobuf bytes
   │
   ├─ OK            → return response bytes
   ├─ retryable     → backoff → next attempt (deadline-guarded)
   └─ non-retryable → throw GrpcError(status)
```

## Getting started

Requires Node ≥ 18.17 (or Bun ≥ 1.0) and TypeScript 5.x to build.

```bash
git clone https://github.com/Retsumdk/grpc-service-mesh.git
cd grpc-service-mesh
bun install          # runs the prepare script, which builds dist/
bun test             # 34 tests
bun run typecheck    # strict tsc over src + tests
```

## Quick start: the demo

```bash
node dist/cli.js demo
```

Two real gRPC servers start on ephemeral ports — `alpha` serves the echo method, `beta` always answers `UNAVAILABLE` — and a round-robin mesh client with retries makes six calls:

```
mesh demo: 2 endpoints — alpha serves echo, beta always answers UNAVAILABLE; round_robin, up to 4 attempts

call-1 -> alpha: call-1
call-2 -> alpha: call-2
call-3 -> alpha: call-3
call-4 -> alpha: call-4
call-5 -> alpha: call-5
call-6 -> alpha: call-6

per-endpoint stats:
  alpha  calls= 6 ok= 6 failed= 0 health=healthy ejectedForMs=0
  beta   calls= 3 ok= 0 failed= 3 health=unknown ejectedForMs=1000

events:
  call-attempt  endpoint=alpha attempt=1 /mesh.demo.Echo/Echo
  call-attempt  endpoint=beta attempt=1 /mesh.demo.Echo/Echo
  call-retry    endpoint=beta attempt=1 status=14 (UNAVAILABLE)
  call-attempt  endpoint=alpha attempt=2 /mesh.demo.Echo/Echo
  call-attempt  endpoint=alpha attempt=1 /mesh.demo.Echo/Echo
  call-attempt  endpoint=beta attempt=1 /mesh.demo.Echo/Echo
  call-retry    endpoint=beta attempt=1 status=14 (UNAVAILABLE)
  call-attempt  endpoint=alpha attempt=2 /mesh.demo.Echo/Echo
  call-attempt  endpoint=alpha attempt=1 /mesh.demo.Echo/Echo
  call-attempt  endpoint=beta attempt=1 /mesh.demo.Echo/Echo
  endpoint-ejected endpoint=beta
  call-retry    endpoint=beta attempt=1 status=14 (UNAVAILABLE)
  call-attempt  endpoint=alpha attempt=2 /mesh.demo.Echo/Echo
```

Read the trace: every call lands on `beta` first (round-robin), fails, retries onto `alpha`, and succeeds — until beta's third consecutive failure trips the breaker (`failuresToEject: 3`) and it is ejected, after which it receives no more traffic.

The demo is byte-for-byte deterministic (frozen injectable clock), which is what lets CI diff two runs.

## Quick start: serve + call

```bash
node dist/cli.js serve --port 5073 &
node dist/cli.js call --address 127.0.0.1:5073 --method /mesh.demo.Echo/Echo --message hello
# → echo: hello
```

`gsm serve` exposes the echo method from [`examples/echo.proto`](examples/echo.proto) plus the standard health service. The contract is deliberately trivial — request field 1 (string) in, reply field 1 (string) out — so `gsm call` can exercise any endpoint speaking it.

## Library usage

```ts
import { MeshClient, writer, decodeMessage, fieldString } from "grpc-service-mesh";

const client = new MeshClient({
  endpoints: [
    { name: "alpha", address: "127.0.0.1:5071" },
    { name: "beta", address: "127.0.0.1:5072", weight: 1 },
  ],
  policy: "round_robin",
  defaultDeadlineMs: 10_000,
});

client.on((event) => console.log("mesh event:", event));

const request = writer().string(1, "hello").toBytes();
const response = await client.call("/mesh.demo.Echo/Echo", request, { deadlineMs: 2_000 });
const reply = decodeMessage(response).find((f) => f.field === 1);
console.log(fieldString(reply!)); // "echo: hello" against gsm serve

client.close();
```

A full runnable pair — server plus a two-endpoint client that fails over — lives in `examples/echo.proto` and `examples/mesh.json` (the client configuration `gsm` understands).

Building a server is symmetric:

```ts
import { startMeshServer, echoHandler } from "grpc-service-mesh";

const server = await startMeshServer({
  port: 5071,
  handlers: { "/mesh.demo.Echo/Echo": echoHandler("echo") },
  healthy: () => true,
});
console.log(`listening on ${server.port}`);
```

## Configuration

`MeshClientOptions` (all optional except `endpoints`):

| Field | Default | Meaning |
| --- | --- | --- |
| `policy` | `"round_robin"` | `"round_robin"` (smooth weighted) or `"pick_first"` |
| `retry.maxAttempts` | `3` | Total attempts per call, including the first |
| `retry.baseBackoffMs` | `50` | First backoff; grows by `backoffMultiplier` per attempt |
| `retry.maxBackoffMs` | `2000` | Backoff ceiling |
| `retry.retryableStatuses` | `[UNAVAILABLE, CANCELED]` | gRPC status codes that trigger a retry |
| `retry.deadlineGuardFraction` | `0.8` | No new attempt once this fraction of the deadline is spent |
| `health.intervalMs` | `0` (disabled) | Active health-check cadence; `0` = passive breaker only |
| `health.failuresToUnhealthy` | `2` | Consecutive failed probes before an endpoint is pulled |
| `health.successesToHealthy` | `1` | Consecutive good probes before it is restored |
| `health.serviceName` | `""` | gRPC health service name (`""` = whole server) |
| `defaultDeadlineMs` | `10000` | Per-call deadline when the caller passes none |
| `failFast` | `false` | `true`: throw immediately when nothing is pickable; `false`: wait out one backoff in case an ejection window lapses |

Per-call overrides via `call(method, request, { deadlineMs, maxAttempts, metadata })`.

## Failure semantics

- A failed attempt always marks the endpoint (`reportFailure`); three consecutive failures (configurable at the balancer level) eject it with an exponentially growing window.
- Retries exclude endpoints already tried in the same call, so each attempt lands on a different backend.
- `DEADLINE_EXCEEDED` from the transport (the `grpc-timeout` header elapsing) is retryable on a fresh endpoint if the call's total deadline still has guard room.
- Non-retryable statuses (`INVALID_ARGUMENT`, `NOT_FOUND`, …) surface immediately as `GrpcError` with the original status.
- When every endpoint is ejected/unhealthy/excluded: `failFast` throws `ALL_ENDPOINTS_UNAVAILABLE` at once; otherwise the client waits one backoff step (ejection windows can lapse) before giving up.

## Project layout

```
src/
  types.ts      public option/event/handler types
  errors.ts     gRPC status table, GrpcError, MeshError
  protobuf.ts   wire-format codec (varint, length-delimited, fixed32/64)
  grpc.ts       HTTP/2 transport: client unaryCall + gRPC server + framing
  balancer.ts   smooth weighted round-robin, pick_first, circuit breaker
  health.ts     active health checker + grpc.health.v1 probe
  mesh.ts       MeshClient: the retry/failover/deadline call loop
  server.ts     MeshServer wrapper, demo echo + failing handlers
  cli.ts        gsm demo / serve / call
tests/          34 tests (codec, framing, balancer, health, end-to-end over real HTTP/2)
examples/       echo.proto contract + mesh.json client configuration
```

## Scripts

| Script | What it does |
| --- | --- |
| `bun test` | Full test suite |
| `bun run typecheck` | `tsc --noEmit` over src and tests |
| `bun run build` | Compile to `dist/` |
| `bun run demo` | The deterministic failover demo |
| `bun run serve` / `bun run call` | CLI server and one-shot client |

## CI

Every push runs the suite, both tsc passes, a demo-determinism diff, a live `serve` + `call` round-trip over real HTTP/2, and a packaged-install import check.

## License

[MIT](LICENSE)
