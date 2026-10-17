#!/usr/bin/env node
/**
 * gsm — CLI for grpc-service-mesh.
 *
 *   gsm demo                          Deterministic failover demo (2 servers, 6 calls)
 *   gsm serve [--port N] [--host H]   Run the demo echo + health gRPC server
 *   gsm call --address H:P --method /pkg.Svc/M [--message text]
 *
 * Exit codes: 0 success, 1 call/runtime failure, 2 usage error.
 */
import { parseArgs } from "node:util";
import { MeshClient } from "./mesh.js";
import { startMeshServer, echoHandler, failingHandler, ECHO_METHOD } from "./server.js";
import { writer, decodeMessage, fieldString } from "./protobuf.js";
import { GrpcStatus, statusName } from "./errors.js";
import type { MeshEvent } from "./types.js";

const USAGE = `gsm — a tiny gRPC service mesh: load balancing, retries, failover, health checks.

Usage:
  gsm demo
      Deterministic demo: two real gRPC servers (one healthy, one always
      UNAVAILABLE), a mesh client with retries, and six calls showing
      failover and circuit-breaker ejection.
  gsm serve [--port <port>] [--host <host>]
      Start the demo echo server (mesh.demo.Echo/Echo) plus the standard
      gRPC health service. Ctrl-C to stop. Defaults: port 5071, host 127.0.0.1.
  gsm call --address <host:port> --method </pkg.Service/Method>
           [--message <text>] [--deadline <ms>]
      Send one unary request whose protobuf message is field 1 = <text>
      (string) and print the response's field 1 string.
  gsm --help | -h
      Show this help.

Exit codes: 0 success, 1 call/runtime failure, 2 usage error.`;

function failUsage(message: string): never {
  process.stderr.write(`error: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function echoRequest(message: string): Uint8Array {
  const w = writer();
  w.string(1, message);
  return w.toBytes();
}

function echoReplyText(bytes: Uint8Array): string {
  const fields = decodeMessage(bytes);
  const f = fields.find((x) => x.field === 1);
  return f !== undefined ? fieldString(f) : "";
}

async function runDemo(): Promise<void> {
  const alpha = await startMeshServer({
    handlers: { [ECHO_METHOD]: echoHandler("alpha") },
    healthy: () => true,
  });
  const beta = await startMeshServer({
    handlers: { [ECHO_METHOD]: failingHandler(GrpcStatus.UNAVAILABLE, "beta is having a bad day") },
    healthy: () => true,
  });

  const events: MeshEvent[] = [];
  const client = new MeshClient({
    endpoints: [
      { name: "alpha", address: `127.0.0.1:${alpha.port}` },
      { name: "beta", address: `127.0.0.1:${beta.port}` },
    ],
    policy: "round_robin",
    retry: {
      maxAttempts: 4,
      baseBackoffMs: 10,
      backoffMultiplier: 2,
      maxBackoffMs: 200,
      retryableStatuses: [GrpcStatus.UNAVAILABLE, GrpcStatus.CANCELED],
      deadlineGuardFraction: 0.8,
    },
    // intervalMs 0 disables background health checks; the demo exercises the
    // passive (failure-driven) circuit breaker instead.
    health: { intervalMs: 0, timeoutMs: 500, failuresToUnhealthy: 2, successesToHealthy: 1, serviceName: "" },
    defaultDeadlineMs: 5_000,
    failFast: false,
    // Frozen injectable clock keeps every printed line byte-for-byte
    // deterministic (CI diffs two demo runs); real timing behavior is
    // exercised by the test suite.
    clock: () => 0,
  });
  client.on((event) => events.push(event));

  process.stdout.write(
    "mesh demo: 2 endpoints — alpha serves echo, beta always answers UNAVAILABLE; round_robin, up to 4 attempts\n\n",
  );

  for (let i = 1; i <= 6; i += 1) {
    const reply = await client.call(ECHO_METHOD, echoRequest(`call-${i}`));
    process.stdout.write(`call-${i} -> ${echoReplyText(reply)}\n`);
  }

  process.stdout.write("\nper-endpoint stats:\n");
  for (const s of client.stats()) {
    process.stdout.write(
      `  ${s.name.padEnd(6)} calls=${String(s.totalCalls).padStart(2)} ok=${String(s.successfulCalls).padStart(2)} failed=${String(s.failedCalls).padStart(2)} health=${s.health} ejectedForMs=${s.ejectedForMs}\n`,
    );
  }
  process.stdout.write("\nevents:\n");
  for (const e of events) {
    if (e.type === "call-attempt") {
      process.stdout.write(`  call-attempt  endpoint=${e.endpoint} attempt=${e.attempt} ${e.method}\n`);
    } else if (e.type === "call-retry") {
      process.stdout.write(`  call-retry    endpoint=${e.endpoint} attempt=${e.attempt} status=${e.status} (${statusName(e.status)})\n`);
    } else if (e.type === "endpoint-ejected") {
      process.stdout.write(`  endpoint-ejected endpoint=${e.endpoint}\n`);
    } else {
      process.stdout.write(`  ${e.type} endpoint=${e.endpoint}\n`);
    }
  }

  client.close();
  await alpha.close();
  await beta.close();
}

async function runCall(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        address: { type: "string" },
        method: { type: "string" },
        message: { type: "string", default: "ping" },
        deadline: { type: "string", default: "10000" },
      },
      allowPositionals: false,
      args: argv,
    });
  } catch (err) {
    failUsage(err instanceof Error ? err.message : String(err));
  }
  const { address, method, message, deadline } = parsed.values as Record<string, string | undefined>;
  if (!address) failUsage("--address is required (host:port)");
  if (!method) failUsage("--method is required (/package.Service/Method)");
  const deadlineMs = Number(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) failUsage("--deadline must be a positive number of milliseconds");

  const client = new MeshClient({ endpoints: [{ name: "target", address }] });
  try {
    const reply = await client.call(method, echoRequest(message ?? "ping"), { deadlineMs });
    process.stdout.write(`${echoReplyText(reply)}\n`);
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      status !== undefined ? `ERROR status ${status} (${statusName(status)}): ${detail}\n` : `ERROR: ${detail}\n`,
    );
    return 1;
  } finally {
    client.close();
  }
}

async function runServe(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(
      { options: { port: { type: "string", default: "5071" }, host: { type: "string", default: "127.0.0.1" } }, allowPositionals: false, args: argv },
    );
  } catch (err) {
    failUsage(err instanceof Error ? err.message : String(err));
  }
  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) failUsage("--port must be an integer in [0, 65535]");
  const host = parsed.values.host;
  if (!host) failUsage("--host must not be empty");

  const server = await startMeshServer({
    port,
    host,
    handlers: { [ECHO_METHOD]: echoHandler("echo") },
    healthy: () => true,
  });
  process.stdout.write(`gsm serve: ${ECHO_METHOD} + grpc.health.v1.Health/Check listening on ${host}:${server.port}\n`);
  process.stdout.write("try: gsm call --address " + `${host}:${server.port} --method ${ECHO_METHOD} --message hello\n`);
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {
    /* serve until signaled */
  });
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("/gsm"));

if (invokedDirectly) {
  const [command = "", ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  let exitCode = 0;
  if (command === "demo") {
    await runDemo();
  } else if (command === "serve") {
    exitCode = await runServe(rest);
  } else if (command === "call") {
    exitCode = await runCall(rest);
  } else {
    failUsage(command === "" ? "a subcommand is required" : `unknown subcommand "${command}"`);
  }
  process.exit(exitCode);
}
