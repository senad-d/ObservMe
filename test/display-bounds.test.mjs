import assert from "node:assert/strict";
import test from "node:test";
import {
  OBS_COMMAND_OUTPUT_MAX_CHARS,
  OBS_COMMAND_OUTPUT_MAX_ROWS,
  boundObsCommandOutput,
} from "../src/safety/display-bounds.ts";

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

test("command output bounding is visible, deterministic, and Unicode-safe", () => {
  const oversized = `prefix-${"🙂".repeat(OBS_COMMAND_OUTPUT_MAX_CHARS)}-tail`;
  const first = boundObsCommandOutput(oversized);
  const second = boundObsCommandOutput(oversized);

  assert.equal(first, second);
  assert.ok(first.length <= OBS_COMMAND_OUTPUT_MAX_CHARS);
  assert.match(first, /\n… output truncated$/u);
  assert.doesNotMatch(first, /-tail/u);
  assert.equal(hasUnpairedSurrogate(first), false);
});

test("command output bounding applies one control-safe row and character policy", () => {
  const rows = Array.from(
    { length: OBS_COMMAND_OUTPUT_MAX_ROWS + 10 },
    (_, index) => `row-${index}\u001b\u0007\u0085\u2028\u2029`,
  );
  const output = boundObsCommandOutput(rows.join("\n"));

  assert.ok(output.length <= OBS_COMMAND_OUTPUT_MAX_CHARS);
  assert.ok(output.split("\n").length <= OBS_COMMAND_OUTPUT_MAX_ROWS);
  assert.match(output, /\n… output truncated$/u);
  assert.doesNotMatch(output.replaceAll("\n", ""), /[\p{Cc}\p{Zl}\p{Zp}]/u);
});
