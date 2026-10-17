/**
 * grpc-service-mesh — a zero-dependency gRPC service mesh for unary calls.
 *
 * Real HTTP/2 gRPC wire protocol (no gRPC libraries), a wire-format protobuf
 * codec, weighted round-robin / pick-first load balancing, deadline-aware
 * retries with exponential backoff, a passive circuit breaker with half-open
 * recovery, and active gRPC health checking.
 */
export type {
  CallContext,
  CallOptions,
  EndpointHealth,
  EndpointSpec,
  EndpointState,
  EndpointStats,
  HealthCheckPolicy,
  LoadBalancingPolicy,
  MeshEvent,
  MeshListener,
  MeshOptions,
  RetryPolicy,
  UnaryHandler,
} from "./types.js";

export {
  GrpcStatus,
  GrpcError,
  MeshError,
  grpcFailure,
  statusForTransportError,
  statusName,
} from "./errors.js";
export type { MeshErrorCode } from "./errors.js";

export {
  decodeMessage,
  decodeVarint,
  encodeTag,
  encodeVarint,
  fieldBool,
  fieldBytes,
  fieldDouble,
  fieldFixed32,
  fieldInt32,
  fieldInt64,
  fieldString,
  fieldVarint,
  findField,
  writer,
} from "./protobuf.js";
export type { DecodedField, ProtobufWriter } from "./protobuf.js";

export {
  GRPC_CONTENT_TYPE,
  HEALTH_CHECK_PATH,
  HEALTH_NOT_SERVING,
  HEALTH_SERVING,
  frameMessage,
  normalizeAuthority,
  startGrpcServer,
  unaryCall,
  unframeMessages,
} from "./grpc.js";
export type {
  GrpcServerOptions,
  RunningGrpcServer,
  UnaryCallOptions,
  UnaryResponse,
} from "./grpc.js";

export { Balancer, DEFAULT_BALANCER_OPTIONS } from "./balancer.js";
export type { BalancerOptions, BalancerEndpointSnapshot } from "./balancer.js";

export { HealthChecker, DEFAULT_HEALTH_POLICY, grpcHealthProbe } from "./health.js";
export type { HealthCheckerOptions, HealthProbe } from "./health.js";

export { DEFAULT_RETRY_POLICY, MeshClient } from "./mesh.js";
export type { EndpointSnapshot, MeshClientOptions } from "./mesh.js";

export {
  startMeshServer,
  echoHandler,
  failingHandler,
  ECHO_METHOD,
} from "./server.js";
export type { MeshServerOptions, RunningMeshServer } from "./server.js";
