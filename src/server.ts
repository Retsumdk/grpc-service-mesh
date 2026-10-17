/**
 * MeshServer — a thin, useful wrapper around the raw HTTP/2 gRPC server:
 * handler registry, standard health service wiring, and a built-in echo
 * service the demo and CLI use as their test subject.
 */
import { startGrpcServer, HEALTH_CHECK_PATH, HEALTH_SERVING, HEALTH_NOT_SERVING, type RunningGrpcServer } from "./grpc.js";
import { writer, decodeMessage, fieldString } from "./protobuf.js";
import { GrpcStatus, grpcFailure, statusName, type GrpcStatusCode } from "./errors.js";
import type { UnaryHandler } from "./types.js";

export interface MeshServerOptions {
  port?: number;
  host?: string;
  /** Handlers keyed by "/package.Service/Method". */
  handlers: Readonly<Record<string, UnaryHandler>>;
  /** Live health flag surfaced through grpc.health.v1.Health/Check. */
  healthy?: () => boolean;
}

export interface RunningMeshServer extends RunningGrpcServer {
  readonly port: number;
  /** Method paths registered on this server (health excluded). */
  methods(): string[];
}

export async function startMeshServer(options: MeshServerOptions): Promise<RunningMeshServer> {
  return startGrpcServer({
    ...options,
  }).then((running) => ({
    port: running.port,
    close: running.close,
    methods: () => Object.keys(options.handlers).sort(),
  }));
}

/** The demo echo contract: request field 1 (string) → reply field 1 (string). */
export const ECHO_METHOD = "/mesh.demo.Echo/Echo";

/** Handler implementing the echo contract above. */
export function echoHandler(prefix = "echo"): UnaryHandler {
  return (request) => {
    const fields = decodeMessage(request);
    const messageField = fields.find((f) => f.field === 1);
    const incoming = messageField !== undefined ? fieldString(messageField) : "";
    const w = writer();
    w.string(1, `${prefix}: ${incoming}`);
    return w.toBytes();
  };
}

/** Handler that always fails with the given status — the failover test subject. */
export function failingHandler(status: GrpcStatusCode, message: string): UnaryHandler {
  return () => {
    throw grpcFailure(status, message);
  };
}

export { HEALTH_CHECK_PATH, HEALTH_SERVING, HEALTH_NOT_SERVING, statusName, GrpcStatus };
