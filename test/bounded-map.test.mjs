import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BoundedMap } from "../src/util/bounded-map.ts";

test("insertion beyond configured limit evicts the oldest entry exactly once", () => {
  const evictions = [];
  const map = new BoundedMap({
    maxSize: 2,
    onEvict: eviction => evictions.push(eviction),
  });

  map.set("first", 1);
  map.set("second", 2);
  map.set("third", 3);

  assert.equal(map.size, 2);
  assert.equal(map.has("first"), false);
  assert.deepEqual([...map.entries()], [
    ["second", 2],
    ["third", 3],
  ]);
  assert.deepEqual(evictions, [{ key: "first", value: 1, reason: "max_size_exceeded" }]);
});

test("one eviction callback fires per entry evicted while loading many entries", () => {
  const evictions = [];
  const map = new BoundedMap({
    maxSize: 2,
    onEvict: eviction => evictions.push(eviction),
    entries: [
      ["first", 1],
      ["second", 2],
      ["third", 3],
      ["fourth", 4],
    ],
  });

  assert.deepEqual([...map], [
    ["third", 3],
    ["fourth", 4],
  ]);
  assert.deepEqual(evictions, [
    { key: "first", value: 1, reason: "max_size_exceeded" },
    { key: "second", value: 2, reason: "max_size_exceeded" },
  ]);
});

test("existing keys update values without unnecessary eviction", () => {
  const evictions = [];
  const map = new BoundedMap({ maxSize: 2, onEvict: eviction => evictions.push(eviction) });

  map.set("first", 1);
  map.set("second", 2);
  map.set("first", 10);

  assert.deepEqual([...map.entries()], [
    ["first", 10],
    ["second", 2],
  ]);
  assert.deepEqual(evictions, []);
});

test("bounded map validates max size", () => {
  assert.throws(() => new BoundedMap({ maxSize: 0 }), /positive integer/u);
  assert.throws(() => new BoundedMap({ maxSize: 1.5 }), /positive integer/u);
});

test("bounded map utility is independent from Pi and OTEL types", async () => {
  const source = await readFile("src/util/bounded-map.ts", "utf8");

  assert.equal(source.includes("@opentelemetry"), false);
  assert.equal(source.includes("@earendil-works/pi"), false);
  assert.equal(source.includes(" from \"../pi"), false);
});
