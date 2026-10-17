import { describe, test, expect } from "bun:test";
import { frameMessage, unframeMessages, normalizeAuthority } from "../src/index.js";
import { MeshError } from "../src/errors.js";

describe("gRPC framing", () => {
  test("frame → unframe round-trips payloads", () => {
    const a = Uint8Array.from([1, 2, 3]);
    const b = Uint8Array.from([]);
    const frames = Buffer.concat([frameMessage(a), frameMessage(b)]);
    const messages = unframeMessages(frames);
    expect(messages.length).toBe(2);
    expect(Array.from(messages[0]!)).toEqual([1, 2, 3]);
    expect(messages[1]!.length).toBe(0);
  });

  test("unframe rejects truncated headers and bodies", () => {
    const full = frameMessage(Uint8Array.from([9, 9]));
    expect(() => unframeMessages(full.subarray(0, 3))).toThrow(MeshError);
    expect(() => unframeMessages(full.subarray(0, 6))).toThrow(MeshError);
  });

  test("unframe rejects compressed frames", () => {
    const frame = frameMessage(Uint8Array.from([1]));
    frame.writeUInt8(1, 0);
    expect(() => unframeMessages(frame)).toThrow(/compressed/);
  });
});

describe("authority normalization", () => {
  test("adds the default port and strips scheme noise", () => {
    expect(normalizeAuthority("localhost:50051")).toBe("localhost:50051");
    expect(normalizeAuthority("http://localhost")).toBe("localhost:80");
    expect(normalizeAuthority("example.com/")).toBe("example.com:80");
  });

  test("rejects malformed addresses", () => {
    expect(() => normalizeAuthority("")).toThrow(MeshError);
    expect(() => normalizeAuthority("host:")).toThrow(MeshError);
    expect(() => normalizeAuthority("host:99999")).toThrow(MeshError);
    expect(() => normalizeAuthority("host:notaport")).toThrow(MeshError);
  });
});
