import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SPAN_NAMES, SPAN_NAMES } from "../src/semconv/spans.ts";

const documentedSpanNames = [
  "pi.session",
  "pi.agent.run",
  "pi.agent.spawn",
  "pi.agent.wait",
  "pi.agent.join",
  "pi.turn",
  "pi.llm.request",
  "pi.tool.call",
  "pi.bash.execution",
  "pi.compaction",
  "pi.branch",
  "pi.model.change",
  "pi.thinking.change",
].sort((left, right) => left.localeCompare(right));

const dottedLowercaseOperationName = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

test("exports every span name documented in semantic convention section 1", () => {
  assert.deepEqual(ALL_SPAN_NAMES, documentedSpanNames);
  assert.equal(SPAN_NAMES.PI_SESSION, "pi.session");
  assert.equal(SPAN_NAMES.PI_AGENT_WAIT, "pi.agent.wait");
  assert.equal(SPAN_NAMES.PI_AGENT_JOIN, "pi.agent.join");
});

test("span names use dotted lowercase operation naming", () => {
  for (const spanName of ALL_SPAN_NAMES) {
    assert.match(spanName, dottedLowercaseOperationName);
  }
});

test("span names do not introduce a bare agent namespace", () => {
  assert.equal(ALL_SPAN_NAMES.some(spanName => spanName.startsWith("agent.")), false);
});

test("span names are unique", () => {
  assert.equal(new Set(ALL_SPAN_NAMES).size, ALL_SPAN_NAMES.length);
});
