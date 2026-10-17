/**
 * Unary gRPC over HTTP/2 — real wire protocol, no gRPC libraries.
 *
 * Frame layout for every DATA payload (gRPC wire format spec):
 *   byte 0     compression flag (0 = uncompressed)
 *   bytes 1-4  big-endian message length
 *   bytes 5..n message bytes
 *
 * Call metadata: content-type application/grpc(+proto), te: trailers,
 * optional grpc-timeout (e.g. "250m"). Result status arrives in trailers
 * as grpc-status / grpc-message.
 */
import http2 from "node:http2";
import type { IncomingHttpHeaders } from "node:http2";
import { GrpcError, grpcFailure, GrpcStatus, MeshError } from "./errors.js";
import { writer } from "./protobuf.js";
import type { UnaryHandler } from "./types.js";

export const GRPC_CONTENT_TYPE = "application/grpc+proto";

export interface UnaryCallOptions {
  deadlineMs?: number;
  metadata?: Readonly<Record<string, string>>;
}

interface ResolvedCall {
  deadlineMs: number;
  metadata: Record<string, string>;
}

function resolveOptions(options: UnaryCallOptions): ResolvedCall {
  const deadlineMs = options.deadlineMs ?? 10_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new MeshError("BAD_CONFIG", `deadlineMs must be a positive finite number, got ${options.deadlineMs}`);
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    metadata[key.toLowerCase()] = String(value);
  }
  return { deadlineMs, metadata };
}

export function frameMessage(message: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt8(0, 0); // uncompressed
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
}

/** Strip the 5-byte gRPC header from an accumulated DATA buffer. */
export function unframeMessages(buf: Buffer): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 5) throw new MeshError("BAD_FRAME", "truncated gRPC frame header");
    const compressed = buf.readUInt8(offset);
    if (compressed !== 0) throw new MeshError("BAD_FRAME", "compressed gRPC frames are not supported");
    const length = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (buf.length - offset < length) throw new MeshError("BAD_FRAME", "truncated gRPC frame body");
    messages.push(new Uint8Array(buf.subarray(offset, offset + length)));
    offset += length;
  }
  return messages;
}

export interface UnaryResponse {
  message: Uint8Array;
  status: number;
  statusMessage: string | null;
}

function grpcTimeoutHeader(deadlineMs: number): string {
  return `${Math.max(1, Math.ceil(deadlineMs))}m`;
}

/**
 * One unary call over a fresh-or-reused HTTP/2 session.
 * Throws GrpcError for any non-OK grpc-status, including DEADLINE_EXCEEDED.
 */
export function unaryCall(
  address: string,
  method: string,
  request: Uint8Array,
  options: UnaryCallOptions = {},
  sessionProvider?: (authority: string) => http2.ClientHttp2Session,
): Promise<UnaryResponse> {
  const { deadlineMs, metadata } = resolveOptions(options);
  if (!method.startsWith("/")) {
    throw new MeshError("BAD_CONFIG", `method must look like "/package.Service/Method", got "${method}"`);
  }
  return new Promise<UnaryResponse>((resolve, reject) => {
    const authority = normalizeAuthority(address);
    let session = sessionProvider?.(authority);
    let ownsSession = session === undefined;
    session ??= http2.connect(`http://${authority}`);
    const h2session: http2.ClientHttp2Session = session;

    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": method,
      ":scheme": "http",
      ":authority": authority,
      "content-type": GRPC_CONTENT_TYPE,
      te: "trailers",
      "grpc-timeout": grpcTimeoutHeader(deadlineMs),
      ...metadata,
    };
    delete headers["host"]; // :authority is the only host header on HTTP/2

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ownsSession) h2session.close();
      fn();
    };

    const stream = h2session.request(headers);
    const timer = setTimeout(() => {
      settle(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new GrpcError(GrpcStatus.DEADLINE_EXCEEDED, `deadline of ${deadlineMs}ms exceeded`, address));
      });
    }, deadlineMs);

    stream.on("error", (err: Error) => {
      settle(() => {
        reject(new GrpcError(GrpcStatus.UNAVAILABLE, `transport error: ${err.message}`, address));
      });
    });

    h2session.on("error", () => {
      /* session-level errors surface on the stream; avoid unhandled events */
    });

    stream.write(frameMessage(request));
    stream.end();

    let responseHeaders: IncomingHttpHeaders = {};
    stream.on("response", (headers: IncomingHttpHeaders) => {
      responseHeaders = headers;
      // `:status` arrives as a string in Node and a number in Bun — coerce both.
      const httpStatus = Number(headers[":status"]);
      if (!Number.isFinite(httpStatus) || httpStatus !== 200) {
        settle(() => {
          reject(
            new GrpcError(
              GrpcStatus.UNAVAILABLE,
              `endpoint returned HTTP ${httpStatus} for ${method}`,
              address,
            ),
          );
        });
      }
    });

    const body: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => body.push(chunk));

    const finishCall = (trailers: IncomingHttpHeaders) => {
      const rawStatus = trailers["grpc-status"];
      // grpc-status may arrive as "0" (string) or 0 (number) depending on runtime.
      const status = rawStatus === undefined || rawStatus === "" ? NaN : Number(rawStatus);
      const messageBytes = unframeMessages(Buffer.concat(body));
      settle(() => {
        resolve({
          message: messageBytes[0] ?? new Uint8Array(0),
          status: Number.isFinite(status) ? status : GrpcStatus.UNKNOWN,
          statusMessage: trailers["grpc-message"] !== undefined ? String(trailers["grpc-message"]) : null,
        });
      });
    };

    stream.on("trailers", finishCall);

    stream.on("close", () => {
      // Fallback for endpoints that put grpc-status in response headers.
      finishCall(responseHeaders);
    });
  });
}

export function normalizeAuthority(address: string): string {
  const trimmed = address.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!trimmed) throw new MeshError("BAD_ADDRESS", "empty address");
  const hostPort = trimmed.includes(":") ? trimmed : `${trimmed}:80`;
  const [host, portRaw] = hostPort.split(":");
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new MeshError("BAD_ADDRESS", `address must be "host:port", got "${address}"`);
  }
  return `${host}:${port}`;
}

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

export interface GrpcServerOptions {
  port?: number;
  host?: string;
  /** Map of "/package.Service/Method" to a unary handler. */
  handlers: Readonly<Record<string, UnaryHandler>>;
  /** Report SERVING for the gRPC standard health protocol. */
  healthy?: () => boolean;
}

export interface RunningGrpcServer {
  readonly port: number;
  close(): Promise<void>;
}

const HEALTH_CHECK_PATH = "/grpc.health.v1.Health/Check";
const HEALTH_SERVING = 1;
const HEALTH_NOT_SERVING = 2;

export function startGrpcServer(options: GrpcServerOptions): Promise<RunningGrpcServer> {
  const server = http2.createServer((req, res) => {
    void handleRequest(req, res, options);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

async function handleRequest(
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
  options: GrpcServerOptions,
): Promise<void> {
  const method = req.url ?? "";
  const contentType = req.headers["content-type"] ?? "";
  const authority = req.headers[":authority"];
  const address = typeof authority === "string" ? authority : "";
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(":") || key.startsWith("grpc-") || key === "te" || key === "content-type") continue;
    if (typeof value === "string") metadata[key] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") metadata[key] = value[0];
  }

  const body: Buffer[] = [];
  for await (const chunk of req) body.push(chunk as Buffer);
  const messages = unframeMessages(Buffer.concat(body));
  const request = messages[0] ?? new Uint8Array(0);

  const finish = (status: number, message: Uint8Array | null, statusMessage: string | null) => {
    res.setHeader("content-type", GRPC_CONTENT_TYPE);
    const sanitizedMessage = statusMessage === null ? null : statusMessage.replace(/[\r\n]/g, " ");
    if (message === null) {
      // Trailers-only response (gRPC spec): with no message body, grpc-status
      // travels in the HEADERS frame. Some HTTP/2 clients (notably Bun) never
      // emit a trailers event for bodyless responses, so header delivery is
      // what keeps the status visible on every runtime.
      res.setHeader("grpc-status", String(status));
      if (sanitizedMessage !== null) res.setHeader("grpc-message", sanitizedMessage);
      res.end();
      return;
    }
    res.write(frameMessage(message));
    res.addTrailers({
      "grpc-status": String(status),
      ...(sanitizedMessage !== null ? { "grpc-message": sanitizedMessage } : {}),
    });
    res.end();
  };

  if (method === HEALTH_CHECK_PATH) {
    if (!options.healthy?.()) {
      finish(GrpcStatus.OK, healthResponse(HEALTH_NOT_SERVING), null);
      return;
    }
    finish(GrpcStatus.OK, healthResponse(HEALTH_SERVING), null);
    return;
  }

  const handler = options.handlers[method];
  if (handler === undefined) {
    finish(GrpcStatus.UNIMPLEMENTED, null, `no handler for ${method}`);
    return;
  }
  if (!contentType.startsWith("application/grpc")) {
    finish(GrpcStatus.INTERNAL, null, `content-type "${contentType}" is not a gRPC content type`);
    return;
  }

  try {
    const response = await handler(request, { method, metadata, address });
    finish(GrpcStatus.OK, response, null);
  } catch (err) {
    const grpcErr = err instanceof GrpcError ? err : null;
    const status = grpcErr?.status ?? GrpcStatus.UNKNOWN;
    const text = err instanceof Error ? err.message : String(err);
    finish(status, null, text);
  }
}

function healthResponse(state: number): Uint8Array {
  // message HealthCheckResponse { int32 status = 1; } — enum SERVING = 1.
  const w = writer();
  w.varint(1, BigInt(state));
  return w.toBytes();
}

export { grpcFailure, HEALTH_CHECK_PATH, HEALTH_NOT_SERVING, HEALTH_SERVING };
