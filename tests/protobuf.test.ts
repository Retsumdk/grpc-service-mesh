import { describe, test, expect } from "bun:test";
import {
  writer,
  decodeMessage,
  fieldString,
  fieldBytes,
  fieldVarint,
  fieldBool,
  fieldInt32,
  fieldInt64,
  fieldDouble,
  fieldFixed32,
  findField,
  encodeVarint,
  decodeVarint,
  encodeTag,
} from "../src/index.js";

describe("protobuf wire codec", () => {
  test("varint round-trips across the full range", () => {
    for (const value of [0n, 1n, 127n, 128n, 300n, 2n ** 32n, 2n ** 63n - 1n, 2n ** 64n - 1n]) {
      const encoded = encodeVarint(value);
      const decoded = decodeVarint(encoded, 0);
      expect(decoded.value).toBe(value);
      expect(decoded.next).toBe(encoded.length);
    }
  });

  test("negative values encode as two's-complement 64-bit varints", () => {
    const encoded = encodeVarint(-1n);
    expect(encoded.length).toBe(10);
    expect(decodeVarint(encoded, 0).value).toBe(2n ** 64n - 1n);
  });

  test("writer/decoder round-trip for strings, bytes, bools, doubles", () => {
    const w = writer();
    w.string(1, "hello world");
    w.bytes(2, Uint8Array.from([1, 2, 3]));
    w.bool(3, true);
    w.bool(4, false);
    w.double(5, 3.25);
    w.fixed32(6, 4294967295);
    w.varint(7, 123456789n);

    const fields = decodeMessage(w.toBytes());
    expect(fieldString(fields[0]!)).toBe("hello world");
    expect(Array.from(fieldBytes(fields[1]!))).toEqual([1, 2, 3]);
    expect(fieldBool(fields[2]!)).toBe(true);
    expect(fieldBool(fields[3]!)).toBe(false);
    expect(fieldDouble(fields[4]!)).toBe(3.25);
    expect(fieldFixed32(fields[5]!)).toBe(4294967295);
    expect(fieldVarint(fields[6]!)).toBe(123456789n);
  });

  test("int32 sign handling: -1 wire value decodes to -1", () => {
    const w = writer();
    // -1 as int32 is encoded as the 64-bit two's complement value on the wire.
    w.varint(1, -1n < 0n ? 2n ** 64n - 1n : -1n);
    const fields = decodeMessage(w.toBytes());
    expect(fieldInt32(fields[0]!)).toBe(-1);
  });

  test("int32 keeps positive values intact", () => {
    const w = writer();
    w.varint(1, 2147483647n);
    const fields = decodeMessage(w.toBytes());
    expect(fieldInt32(fields[0]!)).toBe(2147483647);
  });

  test("int64 sign handling works within the safe integer range", () => {
    const w = writer();
    w.varint(1, 2n ** 64n - 1000n); // -1000 on the wire
    const fields = decodeMessage(w.toBytes());
    expect(fieldInt64(fields[0]!)).toBe(-1000);
  });

  test("nested messages embed as length-delimited fields", () => {
    const inner = writer();
    inner.string(1, "nested");
    const outer = writer();
    outer.message(2, inner.toBytes());
    const fields = decodeMessage(outer.toBytes());
    const embedded = decodeMessage(fieldBytes(fields[0]!));
    expect(fieldString(findField(embedded, 1)!)).toBe("nested");
  });

  test("decodeMessage rejects field number 0 and truncated bodies", () => {
    expect(() => decodeMessage(Uint8Array.from([0]))).toThrow(RangeError);
    // Tag says length-delimited with length 10, but only 2 bytes follow.
    expect(() => decodeMessage(Uint8Array.from([0x12, 0x0a, 1, 2]))).toThrow(RangeError);
  });

  test("decodeVarint rejects over-long varints", () => {
    const elevenBytes = Uint8Array.from(Array(11).fill(0x81));
    expect(() => decodeVarint(elevenBytes, 0)).toThrow(RangeError);
  });

  test("tag encoding is (field << 3) | wireType", () => {
    const tag = decodeVarint(encodeTag(3, 2), 0).value;
    expect(tag).toBe(BigInt((3 << 3) | 2));
  });
});
