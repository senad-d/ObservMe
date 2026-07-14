import assert from "node:assert/strict";
import { MAX_GRAFANA_RESPONSE_BODY_BYTES } from "../src/query/grafana-transport.ts";

const oversizedChunkBytes = Math.floor(MAX_GRAFANA_RESPONSE_BODY_BYTES / 2) + 1;

export function createOversizedGrafanaStreamResponse(headers = {}) {
  const state = { cancelled: false };
  let emittedChunks = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (emittedChunks >= 2) return new Promise(() => {});
      emittedChunks += 1;
      controller.enqueue(new Uint8Array(oversizedChunkBytes));
    },
    cancel() {
      state.cancelled = true;
    },
  });

  return {
    response: new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } }),
    state,
  };
}

export function createExactBoundaryJsonResponse(payload) {
  const emptyBody = JSON.stringify({ ...payload, observmePadding: "" });
  const paddingBytes = MAX_GRAFANA_RESPONSE_BODY_BYTES - Buffer.byteLength(emptyBody);
  assert.ok(paddingBytes >= 0);

  const body = JSON.stringify({ ...payload, observmePadding: "x".repeat(paddingBytes) });
  assert.equal(Buffer.byteLength(body), MAX_GRAFANA_RESPONSE_BODY_BYTES);
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(MAX_GRAFANA_RESPONSE_BODY_BYTES),
      "content-type": "application/json",
    },
  });
}

export function createStallingGrafanaResponse() {
  const state = { cancelled: false };
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { status: 200 }), state };
}
