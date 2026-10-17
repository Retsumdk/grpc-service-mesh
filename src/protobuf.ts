/**
 * Minimal protobuf wire-format codec — enough for unary gRPC request/response
 * payloads without any generated code or runtime dependency.
 *
 * Supports the three wire types needed by typical request/response messages:
 *   0 = varint (int32/int64/enum/bool)
 *   2 = length-delimited (string/bytes/embedded message)
 *   5 = 32-bit fixed (float/fixed32)
 *   1 = 64-bit fixed (double/fixed64)
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

const TWO_32 = 4294967296n;
const TWO_63 = 9223372036854775808n;

export function encodeVarint(value: bigint): Uint8Array {
  let v = value;
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  while (true) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return Uint8Array.from(out);
}

export function encodeTag(field: number, wireType: number): Uint8Array {
  return encodeVarint(BigInt((field << 3) | wireType));
}

export interface ProtobufWriter {
  varint(field: number, value: number | bigint): this;
  bool(field: number, value: boolean): this;
  string(field: number, value: string): this;
  bytes(field: number, value: Uint8Array): this;
  message(field: number, encoded: Uint8Array): this;
  double(field: number, value: number): this;
  float(field: number, value: number): this;
  fixed32(field: number, value: number): this;
  toBytes(): Uint8Array;
}

export function writer(): ProtobufWriter {
  const chunks: Uint8Array[] = [];

  const push = (...parts: Uint8Array[]) => chunks.push(...parts);

  return {
    varint(field, value) {
      push(encodeTag(field, WIRE_VARINT), encodeVarint(BigInt(value)));
      return this;
    },
    bool(field, value) {
      return this.varint(field, value ? 1n : 0n);
    },
    string(field, value) {
      const encoded = new TextEncoder().encode(value);
      push(encodeTag(field, WIRE_LEN), encodeVarint(BigInt(encoded.length)), encoded);
      return this;
    },
    bytes(field, value) {
      push(encodeTag(field, WIRE_LEN), encodeVarint(BigInt(value.length)), value);
      return this;
    },
    message(field, encoded) {
      return this.bytes(field, encoded);
    },
    double(field, value) {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, value, true);
      push(encodeTag(field, WIRE_FIXED64), new Uint8Array(buf));
      return this;
    },
    float(field, value) {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, value, true);
      push(encodeTag(field, WIRE_FIXED32), new Uint8Array(buf));
      return this;
    },
    fixed32(field, value) {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, value >>> 0, true);
      push(encodeTag(field, WIRE_FIXED32), new Uint8Array(buf));
      return this;
    },
    toBytes() {
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
  };
}

export interface DecodedField {
  readonly field: number;
  readonly wireType: number;
  readonly varint?: bigint;
  readonly bytes?: Uint8Array;
}

export function decodeVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) throw new RangeError("truncated varint");
    const byte = buf[pos]!;
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift >= 64n) throw new RangeError("varint too long");
  }
  return { value: result, next: pos };
}

export function decodeMessage(buf: Uint8Array): DecodedField[] {
  const fields: DecodedField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (field === 0) throw new RangeError("invalid field number 0");
    if (wireType === WIRE_VARINT) {
      const v = decodeVarint(buf, pos);
      pos = v.next;
      fields.push({ field, wireType, varint: v.value });
    } else if (wireType === WIRE_LEN) {
      const len = decodeVarint(buf, pos);
      pos = len.next;
      const end = Number(len.value);
      if (pos + end > buf.length) throw new RangeError("length-delimited field overruns buffer");
      fields.push({ field, wireType, bytes: buf.slice(pos, pos + end) });
      pos += end;
    } else if (wireType === WIRE_FIXED64) {
      if (pos + 8 > buf.length) throw new RangeError("truncated fixed64");
      fields.push({ field, wireType, bytes: buf.slice(pos, pos + 8) });
      pos += 8;
    } else if (wireType === WIRE_FIXED32) {
      if (pos + 4 > buf.length) throw new RangeError("truncated fixed32");
      fields.push({ field, wireType, bytes: buf.slice(pos, pos + 4) });
      pos += 4;
    } else {
      throw new RangeError(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

export function fieldString(f: DecodedField): string {
  if (f.bytes === undefined) throw new TypeError("field is not length-delimited");
  return new TextDecoder().decode(f.bytes);
}

export function fieldBytes(f: DecodedField): Uint8Array {
  if (f.bytes === undefined) throw new TypeError("field is not length-delimited");
  return f.bytes;
}

export function fieldVarint(f: DecodedField): bigint {
  if (f.varint === undefined) throw new TypeError("field is not a varint");
  return f.varint;
}

export function fieldBool(f: DecodedField): boolean {
  return fieldVarint(f) !== 0n;
}

/** Signed 64-bit varint → Number (safe for values within Number.MAX_SAFE_INTEGER). */
export function fieldInt64(f: DecodedField): number {
  const raw = fieldVarint(f);
  const magnitude = raw < TWO_63 ? raw : raw - TWO_63 * 2n;
  return Number(magnitude);
}

/** Signed 32-bit view of a varint (protobuf ints are two's complement). */
export function fieldInt32(f: DecodedField): number {
  const TWO_31 = 2147483648n;
  const raw = fieldVarint(f) & (TWO_32 - 1n);
  return raw >= TWO_31 ? Number(raw) - Number(TWO_32) : Number(raw);
}

export function fieldDouble(f: DecodedField): number {
  if (f.bytes === undefined || f.bytes.length !== 8) throw new TypeError("field is not a fixed64");
  return new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true);
}

export function fieldFixed32(f: DecodedField): number {
  if (f.bytes === undefined || f.bytes.length !== 4) throw new TypeError("field is not a fixed32");
  return new DataView(f.bytes.buffer, f.bytes.byteOffset, 4).getUint32(0, true);
}

/** First field with the given number, or undefined. */
export function findField(fields: DecodedField[], field: number): DecodedField | undefined {
  return fields.find((f) => f.field === field);
}
