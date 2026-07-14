import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

export function installSentinelGlobalProviders() {
  resetGlobalProviders();

  const records = { spans: [], metrics: [], logs: [] };
  const tracer = createSentinelTracer(records.spans);
  const meter = createSentinelMeter(records.metrics);
  const logger = createSentinelLogger(records.logs);
  const tracerProvider = { getTracer: () => tracer };
  const meterProvider = { getMeter: () => meter };
  const loggerProvider = { getLogger: () => logger };

  if (!trace.setGlobalTracerProvider(tracerProvider)) throw new Error("Could not install sentinel tracer provider.");
  if (!metrics.setGlobalMeterProvider(meterProvider)) throw new Error("Could not install sentinel meter provider.");
  if (logs.setGlobalLoggerProvider(loggerProvider) !== loggerProvider) {
    throw new Error("Could not install sentinel logger provider.");
  }

  return { records, tracer, meter, logger, tracerProvider, meterProvider, loggerProvider };
}

export function emitUnrelatedGlobalTelemetry() {
  const span = trace.getTracer("unrelated-extension").startSpan("unrelated.span");
  span.end();
  metrics.getMeter("unrelated-extension").createCounter("unrelated.counter").add(1);
  logs.getLogger("unrelated-extension").emit({ body: "unrelated.log" });
}

export function resetGlobalProviders() {
  trace.disable();
  metrics.disable();
  logs.disable();
}

function createSentinelTracer(records) {
  return {
    startSpan: name => ({
      end: () => records.push({ name }),
    }),
  };
}

function createSentinelMeter(records) {
  return {
    createCounter: name => ({
      add: value => records.push({ name, value }),
    }),
  };
}

function createSentinelLogger(records) {
  return {
    emit: record => records.push(record),
  };
}
