import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../src/semconv/attributes.ts";
import { hmac_sha256, resolveTenantSalt, sha256 } from "../src/privacy/hash.ts";
import { CONTENT_LIMIT_KEYS, truncateContent } from "../src/privacy/truncate.ts";

const syntheticSalt = "tenant-specific-synthetic-salt";
const syntheticValue = "normalized value";
const envSaltSource = {
  env: {
    OBSERVME_HASH_SALT: syntheticSalt,
  },
  envName: "OBSERVME_HASH_SALT",
};
const runtimeSaltSource = {
  secureRuntimeConfig: {
    tenantSalt: syntheticSalt,
  },
};

const documentedLimitCases = [
  ["prompt", "maxPromptChars", 12000],
  ["response", "maxResponseChars", 12000],
  ["toolArgument", "maxToolArgumentChars", 8000],
  ["toolResult", "maxToolResultChars", 16000],
  ["bashOutput", "maxBashOutputChars", 16000],
  ["logBody", "maxLogBodyChars", 32000],
];

function expectedSaltedSha256(salt, value) {
  return createHash("sha256").update(`${salt}\0${value}`).digest("hex");
}

function expectedHmacSha256(salt, value) {
  return createHmac("sha256", salt).update(value).digest("hex");
}

test("sha256 implements sha256(tenant_salt + null separator + value)", () => {
  assert.equal(sha256(syntheticValue, envSaltSource), expectedSaltedSha256(syntheticSalt, syntheticValue));
  assert.equal(sha256(syntheticValue, runtimeSaltSource), expectedSaltedSha256(syntheticSalt, syntheticValue));
});

test("hmac_sha256 implements hmac_sha256(tenant_salt, value)", () => {
  assert.equal(hmac_sha256(syntheticValue, envSaltSource), expectedHmacSha256(syntheticSalt, syntheticValue));
  assert.equal(hmac_sha256(syntheticValue, runtimeSaltSource), expectedHmacSha256(syntheticSalt, syntheticValue));
});

test("hashing is stable for the same input and salt and changes with a different salt", () => {
  const firstHash = sha256(syntheticValue, envSaltSource);
  const secondHash = sha256(syntheticValue, envSaltSource);
  const differentSaltHash = sha256(syntheticValue, {
    secureRuntimeConfig: {
      tenantSalt: "different-synthetic-salt",
    },
  });

  assert.equal(firstHash, secondHash);
  assert.notEqual(firstHash, differentSaltHash);
});

test("tenant salt is read only from explicit environment or secure runtime config", () => {
  assert.equal(resolveTenantSalt(envSaltSource), syntheticSalt);
  assert.equal(resolveTenantSalt(runtimeSaltSource), syntheticSalt);
  assert.throws(() => resolveTenantSalt({ env: {}, envName: "OBSERVME_HASH_SALT" }), /is not set/u);
  assert.throws(() => resolveTenantSalt({ env: { OBSERVME_HASH_SALT: "" }, envName: "OBSERVME_HASH_SALT" }), /must not be empty/u);
  assert.throws(() => resolveTenantSalt({ secureRuntimeConfig: { tenantSalt: "" } }), /must not be empty/u);
});

test("content limit mapping matches every documented redaction limit", () => {
  for (const [kind, limitKey, documentedLimit] of documentedLimitCases) {
    assert.equal(CONTENT_LIMIT_KEYS[kind], limitKey);
    assert.equal(defaultObservMeConfig.limits[limitKey], documentedLimit);
  }
});

test("truncation enforces every documented content limit", () => {
  for (const [kind, limitKey] of documentedLimitCases) {
    const limit = defaultObservMeConfig.limits[limitKey];
    const result = truncateContent("x".repeat(limit + 1), kind, defaultObservMeConfig.limits);

    assert.equal(result.value.length, limit);
    assert.equal(result.truncated, true);
    assert.equal(result.originalLength, limit + 1);
  }
});

test("truncation adds documented operational attributes only when content is shortened", () => {
  const truncated = truncateContent("abcd", "prompt", { ...defaultObservMeConfig.limits, maxPromptChars: 3 });
  const untruncated = truncateContent("abc", "prompt", { ...defaultObservMeConfig.limits, maxPromptChars: 3 });

  assert.deepEqual(truncated.attributes, {
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED]: true,
    [COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH]: 4,
  });
  assert.deepEqual(untruncated.attributes, {});
});
