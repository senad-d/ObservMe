import { constants } from "node:fs";
import { lstat, open, stat, unlink, writeFile } from "node:fs/promises";

const [stallPhase, pidFile, cleanupMode] = process.argv.slice(2);
let activeCreate;
let activeOperation = Promise.resolve();
let protocolState = "initial";

await writeFile(pidFile, String(process.pid), "utf8");
process.on("SIGTERM", ignoreTermination);
process.once("disconnect", handleDisconnect);
process.on("message", handleMessage);
setInterval(ignoreTermination, 1_000);

if (stallPhase !== "ready") {
  const directoryStats = await stat(".", { bigint: true });
  sendMessage({ type: "ready", directoryIdentity: toIdentity(directoryStats) });
}

function handleMessage(message) {
  activeOperation = processMessage(message);
}

async function processMessage(message) {
  if (protocolState === "initial") {
    await processInitialMessage(message);
    return;
  }
  if (protocolState === "opened") {
    await processOpenedMessage(message);
    return;
  }
  if (protocolState === "written") await processWrittenMessage(message);
}

async function processInitialMessage(message) {
  if (message?.type === "cancel") {
    if (stallPhase === "cancel") return;
    sendMessage({ type: "cancelled" });
    process.disconnect();
    return;
  }
  if (message?.type !== "create" || typeof message.fileName !== "string") return;

  const fileHandle = await open(
    message.fileName,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const openedStats = await fileHandle.stat({ bigint: true });
  activeCreate = {
    fileHandle,
    fileName: message.fileName,
    identity: toIdentity(openedStats),
    closed: false,
  };
  protocolState = "opened";
  if (stallPhase !== "open") sendMessage({ type: "opened", identity: activeCreate.identity });
}

async function processOpenedMessage(message) {
  if (message?.type === "abort") {
    if (stallPhase === "abort") return;
    await cleanupActiveCreate();
    sendMessage({ type: "aborted" });
    process.disconnect();
    return;
  }
  if (message?.type !== "write" || typeof message.content !== "string" || !activeCreate) return;
  if (stallPhase === "write") return;

  await activeCreate.fileHandle.writeFile(message.content, "utf8");
  const writtenStats = await activeCreate.fileHandle.stat({ bigint: true });
  protocolState = "written";
  sendMessage({ type: "written", identity: toIdentity(writtenStats) });
}

async function processWrittenMessage(message) {
  if (message?.type === "abort") {
    if (stallPhase === "abort") return;
    await cleanupActiveCreate();
    sendMessage({ type: "aborted" });
    process.disconnect();
    return;
  }
  if (message?.type !== "commit" || !activeCreate) return;
  if (stallPhase === "commit") return;

  await activeCreate.fileHandle.close();
  activeCreate.closed = true;
  activeCreate = undefined;
  sendMessage({ type: "committed" });
  process.disconnect();
}

function handleDisconnect() {
  activeOperation = cleanupAfterDisconnect(activeOperation);
}

async function cleanupAfterDisconnect(operation) {
  try {
    await operation;
  } catch {
    // The fixture intentionally lets the parent own timeout and termination diagnostics.
  }
  await cleanupActiveCreate();
}

async function cleanupActiveCreate() {
  const create = activeCreate;
  activeCreate = undefined;
  if (!create || cleanupMode === "skip-cleanup") return;

  if (!create.closed) {
    try {
      await create.fileHandle.close();
      create.closed = true;
    } catch {
      return;
    }
  }

  try {
    const currentStats = await lstat(create.fileName, { bigint: true });
    if (!hasSameIdentity(create.identity, toIdentity(currentStats))) return;
    await unlink(create.fileName);
  } catch {
    // Tests inspect the target and fail if identity-safe cleanup did not finish.
  }
}

function sendMessage(message) {
  process.send?.(message);
}

function toIdentity(stats) {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function hasSameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function ignoreTermination() {
  // Keep the fixture alive so the parent must escalate and reap it.
}
