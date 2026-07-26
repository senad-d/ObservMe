import assert from "node:assert/strict";
import test from "node:test";
import { BoundedMembershipFilter } from "../src/util/bounded-membership-filter.ts";

test("membership remains positive for every recorded value without growing memory", () => {
  const filter = new BoundedMembershipFilter(1);
  const byteLength = filter.byteLength;
  const values = Array.from({ length: 500 }, (_, index) => `child-transition-${index}`);

  assert.equal(filter.has(values[0]), false);
  for (const value of values) filter.add(value);

  assert.equal(filter.byteLength, byteLength);
  assert.ok(values.every(value => filter.has(value)));
});

test("clear removes recorded membership and expected entry count is validated", () => {
  const filter = new BoundedMembershipFilter(2);
  filter.add("child-transition");
  filter.clear();

  assert.equal(filter.has("child-transition"), false);
  assert.throws(() => new BoundedMembershipFilter(0), /positive integer/u);
  assert.throws(() => new BoundedMembershipFilter(1.5), /positive integer/u);
});
