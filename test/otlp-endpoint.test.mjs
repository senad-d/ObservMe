import assert from "node:assert/strict";
import test from "node:test";
import { appendOtlpSignalPath } from "../src/otel/otlp-endpoint.ts";

const endpointCases = [
  {
    name: "root URL",
    baseEndpoint: "https://collector.example.test",
    signalPath: "/v1/traces",
    expected: "https://collector.example.test/v1/traces",
  },
  {
    name: "nested base path",
    baseEndpoint: "https://collector.example.test/tenant/otlp",
    signalPath: "/v1/metrics",
    expected: "https://collector.example.test/tenant/otlp/v1/metrics",
  },
  {
    name: "repeated trailing slashes",
    baseEndpoint: "https://collector.example.test/tenant/otlp///",
    signalPath: "/v1/logs",
    expected: "https://collector.example.test/tenant/otlp/v1/logs",
  },
  {
    name: "invalid URL accepted by existing string-only joining behavior",
    baseEndpoint: "not a valid URL///",
    signalPath: "/v1/traces",
    expected: "not a valid URL/v1/traces",
  },
];

test("OTLP signal paths preserve base paths and existing slash semantics", () => {
  for (const endpointCase of endpointCases) {
    assert.equal(
      appendOtlpSignalPath(endpointCase.baseEndpoint, endpointCase.signalPath),
      endpointCase.expected,
      endpointCase.name,
    );
  }
});
