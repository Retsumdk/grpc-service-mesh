# Changelog

Notable changes to `grpc-service-mesh`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-28

First tagged release. There is no earlier tag, so everything below is the
1.0.0 surface rather than a diff against a previous version.

### Added

- **HTTP/2 gRPC transport for unary calls** (`src/grpc.ts`): a client
  `unaryCall` that writes one length-prefixed frame and reads trailers, and a
  gRPC server built on `node:http2` that frames responses and sets status and
  trailers. Honours the `grpc-timeout` header and cancels the HTTP/2 stream
  when it elapses.
- **Hand-written protobuf wire codec** (`src/protobuf.ts`) for varint,
  length-delimited and fixed32/64 fields, so the demo and the example services
  run without a code-generation step. Library handlers and calls speak raw
  `Uint8Array`, so a generated codec can be used instead.
- **Balancers** (`src/balancer.ts`): smooth weighted round-robin and
  pick_first, plus a passive circuit breaker with half-open recovery and an
  ejection window that grows per consecutive failure.
- **`MeshClient` call loop** (`src/mesh.ts`): deadline-aware retries with
  exponential backoff, endpoints already tried in a call excluded from later
  attempts, and either a fail-fast `ALL_ENDPOINTS_UNAVAILABLE` or one bounded
  wait when every endpoint is ejected, unhealthy or excluded.
- **Health checking** (`src/health.ts`): an active checker plus a
  `grpc.health.v1` probe.
- **CLI** (`src/cli.ts`): `gsm demo`, `gsm serve`, `gsm call`.
- **Example contract and client configuration** in `examples/`: `echo.proto`
  and `mesh.json`.

### Verification at this tag

- `bun test`: 34 tests across 5 files, all passing (codec, framing, balancer,
  health, end-to-end over real HTTP/2).
- `bun run build` followed by `node dist/cli.js demo`: two demo endpoints,
  weighted routing, a retry on `UNAVAILABLE` landing on the surviving endpoint,
  ejection of the failing endpoint, and per-endpoint call statistics.
- Zero runtime dependencies. The dev dependencies are `typescript`,
  `@types/node` and `bun-types` only.

### Scope

These are deliberate limits of 1.0.0, not bugs to report:

- Unary calls only. Client-streaming, server-streaming and bidi calls are not
  implemented.
- No `.proto` parsing and no code generation. Messages are encoded with the
  bundled codec or supplied by the caller.
- Health checking uses a unary `Check` probe, not a `Watch` stream.
- Weighted round-robin assumes the weights fit in a number; there is no
  consistent-hashing or session-affinity balancer.
