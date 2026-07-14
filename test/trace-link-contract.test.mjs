import assert from "node:assert/strict";
import test from "node:test";
import { handleObsLinkCommand } from "../src/commands/obs-link.ts";
import {
  clearObsSessionRuntimeState,
  handleObsSessionCommand,
  startObsSessionRuntimeState,
} from "../src/commands/obs-session.ts";
import { handleObsTraceCommand } from "../src/commands/obs-trace.ts";
import { PROJECT_OBSERVME_YAML_TEMPLATE } from "../src/config/bootstrap-project-config.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { parseObservMeConfigText } from "../src/config/load-config.ts";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceLinkConfigurationError = "Grafana trace link configuration is invalid";
const placeholderCases = [
  { name: "double braces", trace: "{{ traceId }}", datasource: "{{ tempoDatasourceUid }}" },
  { name: "braces", trace: "{traceId}", datasource: "{tempoDatasourceUid}" },
  { name: "dollar braces", trace: "${traceId}", datasource: "${tempoDatasourceUid}" },
  { name: "percent tokens", trace: "%TRACE_ID%", datasource: "%TEMPO_DATASOURCE_UID%" },
];

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createCommandContext(notifications) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
  };
}

function createGeneratedStarterConfig() {
  const parsed = parseObservMeConfigText(PROJECT_OBSERVME_YAML_TEMPLATE);
  const config = cloneDefaultConfig();
  config.query.links.traceUrlTemplate = parsed.query.links.traceUrlTemplate;
  config.query.grafana.url = parsed.query.grafana.url;
  config.query.grafana.datasourceUids.tempo = parsed.query.grafana.datasourceUids.tempo;
  return config;
}

async function renderTraceLinksForAllCommands(config) {
  clearObsSessionRuntimeState();
  startObsSessionRuntimeState({ sessionId: "session-contract", traceId, config });

  const sessionNotifications = [];
  const traceNotifications = [];
  const linkNotifications = [];
  await handleObsSessionCommand("session", createCommandContext(sessionNotifications));
  await handleObsTraceCommand("trace", createCommandContext(traceNotifications), { loadConfig: async () => config });
  await handleObsLinkCommand("link", createCommandContext(linkNotifications), { loadConfig: async () => config });

  return { sessionNotifications, traceNotifications, linkNotifications };
}

function readOpenTraceLink(notification) {
  const match = /^Open trace: (.+)$/mu.exec(notification.message);
  assert.ok(match, `expected an Open trace line in: ${notification.message}`);
  return match[1];
}

function assertCanonicalCommandLinks(notifications) {
  const links = [
    readOpenTraceLink(notifications.sessionNotifications[0]),
    readOpenTraceLink(notifications.traceNotifications[0]),
    readOpenTraceLink(notifications.linkNotifications[0]),
  ];
  assert.equal(new Set(links).size, 1);
  return links[0];
}

function assertBoundedTraceLinkDiagnostic(notification) {
  assert.match(notification.message, new RegExp(traceLinkConfigurationError, "u"));
  assert.ok(notification.message.length <= 700, `diagnostic length was ${notification.message.length}`);
}

test("generated starter fallback produces one structured Grafana Explore link for session, trace, and link commands", async t => {
  t.after(clearObsSessionRuntimeState);
  const notifications = await renderTraceLinksForAllCommands(createGeneratedStarterConfig());
  const link = assertCanonicalCommandLinks(notifications);
  const url = new URL(link);
  const panes = JSON.parse(url.searchParams.get("panes"));

  assert.equal(url.origin + url.pathname, "https://observability.local/explore");
  assert.equal(url.searchParams.get("schemaVersion"), "1");
  assert.equal(panes.observmeTrace.datasource, "tempo");
  assert.equal(panes.observmeTrace.queries[0].query, traceId);
});

for (const placeholderCase of placeholderCases) {
  test(`canonical trace links support ${placeholderCase.name} with encoded datasource UIDs`, async t => {
    t.after(clearObsSessionRuntimeState);
    const config = cloneDefaultConfig();
    config.query.grafana.datasourceUids.tempo = "tempo/main + production";
    config.query.links.traceUrlTemplate =
      `https://grafana.local/observability/explore?trace=${placeholderCase.trace}&ds=${placeholderCase.datasource}`;

    const notifications = await renderTraceLinksForAllCommands(config);
    const link = assertCanonicalCommandLinks(notifications);
    assert.equal(
      link,
      `https://grafana.local/observability/explore?trace=${traceId}&ds=tempo%2Fmain%20%2B%20production`,
    );
  });
}

test("ellipsis fallback preserves a path-prefixed Grafana base URL for every command", async t => {
  t.after(clearObsSessionRuntimeState);
  const config = createGeneratedStarterConfig();
  config.query.grafana.url = "https://grafana.local/observability/";

  const notifications = await renderTraceLinksForAllCommands(config);
  const link = assertCanonicalCommandLinks(notifications);
  assert.equal(new URL(link).origin + new URL(link).pathname, "https://grafana.local/observability/explore");
});

test("unsupported and invalid templates produce one bounded actionable diagnostic per command", async t => {
  t.after(clearObsSessionRuntimeState);
  const invalidConfigs = [
    { name: "unsupported placeholder", template: "https://grafana.local/explore?trace=$traceId" },
    { name: "invalid protocol", template: "javascript:{traceId}" },
    { name: "unresolved double-brace placeholder", template: "https://grafana.local/explore?trace={traceId}&other={{ unknown }}" },
    { name: "unresolved dollar-brace placeholder", template: "https://grafana.local/explore?trace={traceId}&other=${unknown}" },
    { name: "unresolved brace placeholder", template: "https://grafana.local/explore?trace={traceId}&other={unknown}" },
    { name: "unresolved percent placeholder", template: "https://grafana.local/explore?trace={traceId}&other=%UNKNOWN%" },
    { name: "unresolved legacy trace placeholder", template: "https://grafana.local/explore?trace={traceId}&other=$traceId" },
    { name: "unresolved trace sentinel", template: "https://grafana.local/explore?trace={traceId}&other=__TRACE_ID__" },
  ];

  for (const invalidConfig of invalidConfigs) {
    const config = cloneDefaultConfig();
    config.query.links.traceUrlTemplate = invalidConfig.template;
    const notifications = await renderTraceLinksForAllCommands(config);
    const allNotifications = [
      ...notifications.sessionNotifications,
      ...notifications.traceNotifications,
      ...notifications.linkNotifications,
    ];

    assert.equal(allNotifications.length, 3, invalidConfig.name);
    assert.equal(notifications.sessionNotifications[0].type, "warning", invalidConfig.name);
    assert.equal(notifications.traceNotifications[0].type, "error", invalidConfig.name);
    assert.equal(notifications.linkNotifications[0].type, "error", invalidConfig.name);
    for (const notification of allNotifications) assertBoundedTraceLinkDiagnostic(notification);
    assert.doesNotMatch(allNotifications.map(notification => notification.message).join("\n"), /javascript:|\$traceId|\{unknown\}/u);
  }
});
