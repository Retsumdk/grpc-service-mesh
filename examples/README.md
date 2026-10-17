# Examples

## 1. Start two echo servers

```bash
node dist/cli.js serve --port 5071 &
node dist/cli.js serve --port 5072 &
```

Both expose `mesh.demo.Echo/Echo` (see `echo.proto`) and the standard
`grpc.health.v1.Health/Check` service.

## 2. Call them through the mesh

```bash
node dist/cli.js call --address 127.0.0.1:5071 --method /mesh.demo.Echo/Echo --message hello
# -> echo: hello
```

## 3. Or use the library

```ts
import { MeshClient, writer } from "grpc-service-mesh";

const client = new MeshClient({
  endpoints: [
    { name: "alpha", address: "127.0.0.1:5071" },
    { name: "beta", address: "127.0.0.1:5072" },
  ],
  policy: "round_robin",
  retry: { maxAttempts: 3, baseBackoffMs: 50, backoffMultiplier: 2, maxBackoffMs: 2000, retryableStatuses: [14, 1], deadlineGuardFraction: 0.8 },
  health: { intervalMs: 0, timeoutMs: 500, failuresToUnhealthy: 2, successesToHealthy: 1, serviceName: "" },
  defaultDeadlineMs: 10_000,
  failFast: false,
});

const reply = await client.call("/mesh.demo.Echo/Echo", writer().string(1, "hello").toBytes());
client.close();
```

`mesh.json` is the same configuration as JSON, for tools that consume endpoint
topology as data.
