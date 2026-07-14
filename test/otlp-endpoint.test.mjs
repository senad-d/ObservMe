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
    name: "IPv4 host",
    baseEndpoint: "http://127.0.0.1:4318/base/",
    signalPath: "/v1/traces",
    expected: "http://127.0.0.1:4318/base/v1/traces",
  },
  {
    name: "IPv6 host",
    baseEndpoint: "http://[2001:db8::1]:4318/base/",
    signalPath: "/v1/metrics",
    expected: "http://[2001:db8::1]:4318/base/v1/metrics",
  },
  {
    name: "percent-encoded base path",
    baseEndpoint: "https://collector.example.test/tenant%20one/%2Froot/",
    signalPath: "///v1/logs",
    expected: "https://collector.example.test/tenant%20one/%2Froot/v1/logs",
  },
];

test("OTLP signal paths use URL pathname semantics with one deterministic suffix", () => {
  for (const endpointCase of endpointCases) {
    assert.equal(
      appendOtlpSignalPath(endpointCase.baseEndpoint, endpointCase.signalPath),
      endpointCase.expected,
      endpointCase.name,
    );
  }
});

test("OTLP signal path construction rejects unsafe or malformed base URLs without echoing them", () => {
  const endpointCases = [
    "not a valid URL///",
    "ftp://private.example.test/base",
    "https://private-user:private-password@collector.example.test/base",
    "https://collector.example.test/base?token=private-query",
    "https://collector.example.test/base#private-fragment",
    "https://collector.example.test/${PRIVATE_ENDPOINT}",
  ];

  for (const endpoint of endpointCases) {
    assert.throws(
      () => appendOtlpSignalPath(endpoint, "/v1/traces"),
      error => error instanceof TypeError && !error.message.includes("private"),
    );
  }
});
