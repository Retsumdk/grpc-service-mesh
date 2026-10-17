import { describe, test, expect } from "bun:test";
import * as mesh from "../src/index.js";

describe("grpc-service-mesh public API", () => {
  test("exports the documented surface", () => {
    // Transport
    expect(typeof mesh.unaryCall).toBe("function");
    expect(typeof mesh.startGrpcServer).toBe("function");
    expect(typeof mesh.frameMessage).toBe("function");
    expect(typeof mesh.unframeMessages).toBe("function");
    expect(typeof mesh.normalizeAuthority).toBe("function");
    // Codec
    expect(typeof mesh.writer).toBe("function");
    expect(typeof mesh.decodeMessage).toBe("function");
    expect(typeof mesh.encodeVarint).toBe("function");
    // Mesh
    expect(typeof mesh.MeshClient).toBe("function");
    expect(typeof mesh.Balancer).toBe("function");
    expect(typeof mesh.HealthChecker).toBe("function");
    expect(typeof mesh.grpcHealthProbe).toBe("function");
    expect(mesh.DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(0);
    expect(mesh.DEFAULT_HEALTH_POLICY.timeoutMs).toBeGreaterThan(0);
    expect(mesh.GrpcStatus.OK).toBe(0);
    expect(mesh.GRPC_CONTENT_TYPE).toBe("application/grpc+proto");
    expect(typeof mesh.grpcFailure).toBe("function");
    expect(typeof mesh.statusName).toBe("function");
  });
});
