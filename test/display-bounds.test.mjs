import assert from "node:assert/strict";
import test from "node:test";
import {
  OBS_BACKEND_LABEL_MAX_CHARS,
  OBS_COMMAND_OUTPUT_MAX_CHARS,
  OBS_COMMAND_OUTPUT_MAX_ROWS,
  boundObsCommandOutput,
  normalizeObsBackendLabel,
} from "../src/safety/display-bounds.ts";

const bidiControls = "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
const bidiControlPattern = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

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

test("backend labels neutralize bidi controls while preserving and bounding ordinary Unicode", () => {
  const ordinaryUnicode = "العربية 日本語 हिन्दी 🙂";
  const normalized = normalizeObsBackendLabel(` ${ordinaryUnicode}${bidiControls} visible `);
  const truncated = normalizeObsBackendLabel(`prefix-${"🙂".repeat(OBS_BACKEND_LABEL_MAX_CHARS)}-tail`);

  assert.equal(normalized, `${ordinaryUnicode} visible`);
  assert.doesNotMatch(normalized, bidiControlPattern);
  assert.ok(truncated.length <= OBS_BACKEND_LABEL_MAX_CHARS);
  assert.match(truncated, /…$/u);
  assert.equal(hasUnpairedSurrogate(truncated), false);
});

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
    (_, index) => `row-${index}${bidiControls}\u001b\u0007\u0085\u2028\u2029 العربية`,
  );
  const output = boundObsCommandOutput(rows.join("\n"));

  assert.ok(output.length <= OBS_COMMAND_OUTPUT_MAX_CHARS);
  assert.ok(output.split("\n").length <= OBS_COMMAND_OUTPUT_MAX_ROWS);
  assert.match(output, /\n… output truncated$/u);
  assert.match(output, /العربية/u);
  assert.doesNotMatch(output.replaceAll("\n", ""), /[\p{Cc}\p{Zl}\p{Zp}]/u);
  assert.doesNotMatch(output, bidiControlPattern);
});
