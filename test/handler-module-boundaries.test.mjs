import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const handlerRoot = new URL("../src/pi/", import.meta.url);
const eventHandlerFiles = [
  "agent-turn.ts",
  "lifecycle.ts",
  "llm.ts",
  "session-events.ts",
  "tool-bash.ts",
];
const expectedRegistrationFunctions = new Map([
  ["agent-turn.ts", "registerAgentTurnHandlers"],
  ["lifecycle.ts", "registerLifecycleHandlers"],
  ["llm.ts", "registerLlmHandlers"],
  ["session-events.ts", "registerSessionEventHandlers"],
  ["tool-bash.ts", "registerToolBashHandlers"],
]);

async function readPiSource(relativePath) {
  return readFile(new URL(relativePath, handlerRoot), "utf8");
}

function eventFamilyImports(source) {
  const imports = [];
  const pattern = /from "\.\/(agent-turn|lifecycle|llm|session-events|tool-bash)\.ts";/gu;
  for (const match of source.matchAll(pattern)) imports.push(`${match[1]}.ts`);
  return imports;
}

function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();
  for (const node of graph.keys()) visitGraphNode(node, graph, visiting, visited);
}

function visitGraphNode(node, graph, visiting, visited) {
  if (visited.has(node)) return;
  assert.equal(visiting.has(node), false, `circular event-handler dependency at ${node}`);
  visiting.add(node);
  for (const dependency of graph.get(node) ?? []) visitGraphNode(dependency, graph, visiting, visited);
  visiting.delete(node);
  visited.add(node);
}

test("handlers facade stays thin and delegates event families", async () => {
  const source = await readPiSource("handlers.ts");

  assert.ok(source.split("\n").length < 100);
  assert.doesNotMatch(source, /\.on\("/u);
  for (const registrationFunction of expectedRegistrationFunctions.values()) {
    assert.match(source, new RegExp(`${registrationFunction}\\(registrar, state`, "u"));
  }
});

test("each event family exposes one registration function without closure-based handler factories", async () => {
  for (const file of eventHandlerFiles) {
    const source = await readPiSource(`event-handlers/${file}`);
    const registrations = [...source.matchAll(/^export function (register\w+Handlers)\(/gmu)].map(match => match[1]);

    assert.deepEqual(registrations, [expectedRegistrationFunctions.get(file)]);
    assert.doesNotMatch(source, /return\s+(?:async\s+)?\([^)]*\)\s*=>/u);
  }
});

test("event-handler family imports are acyclic and shared types do not depend on the facade", async () => {
  const graph = new Map();
  for (const file of eventHandlerFiles) {
    const source = await readPiSource(`event-handlers/${file}`);
    graph.set(file, eventFamilyImports(source));
  }

  assertAcyclic(graph);
  assert.doesNotMatch(await readPiSource("handler-types.ts"), /from "\.\/handlers\.ts"/u);
  assert.doesNotMatch(await readPiSource("handler-internals.ts"), /from "\.\/handlers\.ts"/u);
  assert.doesNotMatch(await readPiSource("subagent-spawn.ts"), /from "\.\/handlers\.ts"/u);
});
