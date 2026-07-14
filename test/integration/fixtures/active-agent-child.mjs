import { defaultObservMeConfig } from "../../../src/config/defaults.ts";
import { registerHandlers } from "../../../src/pi/handlers.ts";

const handlers = new Map();
const pi = { on: registerHandler };
const context = createContext();
let shutdownStarted = false;
let handlerFailed = false;

function registerHandler(eventName, handler) {
  handlers.set(eventName, handler);
}

function createContext() {
  return {
    sessionId: "active-agent-lease-integration",
    model: {
      provider: "integration",
      id: "lease-fixture",
      api: "messages",
    },
    thinking: { level: "off" },
    ui: { setStatus: ignoreStatus },
    isProjectTrusted: returnTrue,
  };
}

function ignoreStatus() {
  return undefined;
}

function returnTrue() {
  return true;
}

function createConfig() {
  const config = structuredClone(defaultObservMeConfig);

  config.environment = "test";
  config.tenant = "lease-integration";
  config.otlp.endpoint = requiredEndpoint();
  config.otlp.headers = {};
  config.otlp.timeoutMs = 2000;
  config.otlp.tls.enabled = false;
  config.privacy.allowInsecureTransport = true;
  config.resource.attributes = {
    "service.name": "observme-active-agent-lease-integration",
    "observme.tenant.id": "lease-integration",
    "pi.project.name": "lease-integration",
    "deployment.environment.name": "test",
  };
  config.traces.enabled = false;
  config.metrics.exportIntervalMillis = 2000;
  config.metrics.exportTimeoutMillis = 1000;
  config.metrics.activeAgentLeaseDurationMillis = 10_000;
  config.logs.enabled = false;
  config.query.enabled = false;
  config.shutdown.flushTimeoutMs = 5000;

  return config;
}

function requiredEndpoint() {
  const endpoint = process.env.OBSERVME_IT_OTLP_ENDPOINT;
  if (typeof endpoint !== "string" || !endpoint.startsWith("http://127.0.0.1:")) {
    throw new Error("A loopback OTLP integration endpoint is required.");
  }
  return endpoint;
}

function skipProjectConfigBootstrap() {
  return Promise.resolve({ path: "", status: "exists" });
}

function loadFixtureConfig() {
  return Promise.resolve(createConfig());
}

function recordHandlerFailure() {
  handlerFailed = true;
}

async function invoke(eventName, event) {
  const handler = handlers.get(eventName);
  if (typeof handler !== "function") throw new Error("Required lifecycle handler is unavailable.");
  await handler(event, context);
  if (handlerFailed) throw new Error("A lifecycle handler failed.");
}

function sendStatus(type) {
  if (process.connected) process.send?.({ type });
}

async function startFixture() {
  registerHandlers(pi, {
    env: {},
    ensureProjectConfig: skipProjectConfigBootstrap,
    loadConfig: loadFixtureConfig,
    onHandlerError: recordHandlerFailure,
  });

  await invoke("session_start", {
    sessionId: "active-agent-lease-integration",
    sessionName: "Active Agent Lease Integration",
    persisted: false,
    sessionVersion: "integration",
    modelProvider: "integration",
    modelId: "lease-fixture",
    thinkingLevel: "off",
  });
  sendStatus("ready");
}

async function shutdownFixture() {
  if (shutdownStarted) return;
  shutdownStarted = true;

  try {
    await invoke("session_shutdown", { reason: "integration", success: true });
    sendStatus("stopped");
    process.disconnect?.();
    process.exit(0);
  } catch {
    failFixture();
  }
}

function handleParentMessage(message) {
  if (message && typeof message === "object" && message.type === "shutdown") {
    void shutdownFixture();
  }
}

function handleSigterm() {
  void shutdownFixture();
}

function failFixture() {
  sendStatus("failed");
  process.disconnect?.();
  process.exit(1);
}

process.on("message", handleParentMessage);
process.on("SIGTERM", handleSigterm);

try {
  await startFixture();
} catch {
  failFixture();
}
