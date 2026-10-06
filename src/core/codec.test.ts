// Adapted from voltr-integration-scripts packages/core/src/codec.test.ts (19072d0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeU16Le, encodeU64Le } from "./codec.js";

test("encodeU64Le encodes little-endian u64 bytes", () => {
  assert.deepEqual(Array.from(encodeU64Le(0n)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(encodeU64Le(1n)), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(encodeU64Le(256n)), [0, 1, 0, 0, 0, 0, 0, 0]);
});

test("encodeU16Le encodes little-endian u16 bytes", () => {
  assert.deepEqual(Array.from(encodeU16Le(0)), [0, 0]);
  assert.deepEqual(Array.from(encodeU16Le(1)), [1, 0]);
  assert.deepEqual(Array.from(encodeU16Le(500)), [500 & 0xff, 500 >> 8]);
});

test("encoders reject out-of-range values", () => {
  assert.throws(() => encodeU16Le(70_000));
  assert.throws(() => encodeU64Le(-1n));
});
