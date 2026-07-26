import { constants } from "node:fs";
import { lstat, open, stat, unlink } from "node:fs/promises";
import { basename } from "node:path";

let activeCreate;
let activeOperation = Promise.resolve();
let parentDisconnected = false;

if (process.send) {
  try {
    const directoryStats = await stat(".", { bigint: true });
    if (!directoryStats.isDirectory()) throw createHelperError("ENOTDIR");
    process.once("message", handleInitialMessage);
    process.once("disconnect", handleParentDisconnect);
    sendMessage({
      type: "ready",
      directoryIdentity: toFileIdentity(directoryStats),
    });
  } catch (error) {
    sendFailure(error);
    disconnectHelper();
  }
}

function handleInitialMessage(message) {
  activeOperation = processInitialMessage(message);
}

async function processInitialMessage(message) {
  if (isCancelMessage(message)) {
    sendMessage({ type: "cancelled" });
    disconnectHelper();
    return;
  }
  if (!isCreateMessage(message)) {
    sendFailure(createHelperError("EINVAL"));
    disconnectHelper();
    return;
  }

  let fileHandle;

  try {
    fileHandle = await open(message.fileName, createExclusiveWriteOpenFlags(), 0o600);
    const openedStats = await fileHandle.stat({ bigint: true });
    activeCreate = {
      fileHandle,
      fileName: message.fileName,
      identity: toFileIdentity(openedStats),
      closed: false,
    };
    if (!openedStats.isFile()) throw createHelperError("EINVAL");
    if (parentDisconnected) {
      await cleanupActiveCreate();
      return;
    }
    process.once("message", handleOpenedMessage);
    sendMessage({ type: "opened", identity: activeCreate.identity });
  } catch (error) {
    if (activeCreate) {
      await failActiveCreate(error);
      return;
    }
    if (fileHandle) {
      await reportUntrackedOpenFailure(fileHandle);
      return;
    }
    if (isFileAlreadyExistsError(error)) sendMessage({ type: "exists" });
    else sendFailure(error);
    disconnectHelper();
  }
}

function handleOpenedMessage(message) {
  activeOperation = processOpenedMessage(message);
}

async function processOpenedMessage(message) {
  if (isAbortMessage(message)) {
    await abortActiveCreate();
    return;
  }
  if (!isWriteMessage(message) || !activeCreate) {
    await failActiveCreate(createHelperError("EINVAL"));
    return;
  }

  const create = activeCreate;
  try {
    await create.fileHandle.writeFile(message.content, { encoding: "utf8" });
    const writtenStats = await create.fileHandle.stat({ bigint: true });
    if (!writtenStats.isFile() || !hasSameIdentity(create.identity, toFileIdentity(writtenStats))) {
      throw createHelperError("EINVAL");
    }
    if (parentDisconnected) {
      await cleanupActiveCreate();
      return;
    }
    process.once("message", handleFinalizeMessage);
    sendMessage({ type: "written", identity: create.identity });
  } catch (error) {
    await failActiveCreate(error);
  }
}

function handleFinalizeMessage(message) {
  activeOperation = processFinalizeMessage(message);
}

async function processFinalizeMessage(message) {
  if (isAbortMessage(message)) {
    await abortActiveCreate();
    return;
  }
  if (!isCommitMessage(message) || !activeCreate) {
    await failActiveCreate(createHelperError("EINVAL"));
    return;
  }

  const create = activeCreate;
  try {
    await create.fileHandle.close();
    create.closed = true;
    if (parentDisconnected) {
      await cleanupActiveCreate();
      return;
    }
    activeCreate = undefined;
    sendMessage({ type: "committed" });
    disconnectHelper();
  } catch (error) {
    await failActiveCreate(error);
  }
}

async function reportUntrackedOpenFailure(fileHandle) {
  try {
    await fileHandle.close();
  } catch {
    sendMessage({ type: "cleanup_failed" });
    disconnectHelper();
    return;
  }

  sendMessage({ type: "cleanup_failed" });
  disconnectHelper();
}

async function abortActiveCreate() {
  const cleanupSucceeded = await cleanupActiveCreate();
  sendMessage({ type: cleanupSucceeded ? "aborted" : "cleanup_failed" });
  disconnectHelper();
}

async function failActiveCreate(error) {
  const cleanupSucceeded = await cleanupActiveCreate();
  if (!cleanupSucceeded) sendMessage({ type: "cleanup_failed" });
  else sendFailure(error);
  disconnectHelper();
}

async function cleanupActiveCreate() {
  const create = activeCreate;
  activeCreate = undefined;
  if (!create) return true;

  if (!create.closed) {
    try {
      await create.fileHandle.close();
      create.closed = true;
    } catch {
      return false;
    }
  }

  try {
    const currentStats = await lstat(create.fileName, { bigint: true });
    if (!hasSameIdentity(create.identity, toFileIdentity(currentStats))) return false;
    await unlink(create.fileName);
    return true;
  } catch (error) {
    return isMissingPathError(error);
  }
}

function handleParentDisconnect() {
  parentDisconnected = true;
  activeOperation = cleanupAfterParentDisconnect(activeOperation);
}

async function cleanupAfterParentDisconnect(operation) {
  try {
    await operation;
  } catch {
    // The active protocol handler owns its failure response; disconnect cleanup still runs.
  }
  await cleanupActiveCreate();
}

function createExclusiveWriteOpenFlags() {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | optionalOpenFlag(constants.O_NOFOLLOW);
}

function optionalOpenFlag(flag) {
  return typeof flag === "number" ? flag : 0;
}

function toFileIdentity(stats) {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function hasSameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function isCreateMessage(message) {
  if (!isMessageRecord(message) || message.type !== "create") return false;
  return isSafeFileName(message.fileName);
}

function isWriteMessage(message) {
  return isMessageRecord(message) && message.type === "write" && typeof message.content === "string";
}

function isCancelMessage(message) {
  return isMessageRecord(message) && message.type === "cancel";
}

function isAbortMessage(message) {
  return isMessageRecord(message) && message.type === "abort";
}

function isCommitMessage(message) {
  return isMessageRecord(message) && message.type === "commit";
}

function isMessageRecord(message) {
  return typeof message === "object" && message !== null;
}

function isSafeFileName(fileName) {
  return typeof fileName === "string" && fileName.length > 0 && basename(fileName) === fileName;
}

function isFileAlreadyExistsError(error) {
  return isErrorWithCode(error) && error.code === "EEXIST";
}

function isMissingPathError(error) {
  return isErrorWithCode(error) && error.code === "ENOENT";
}

function isErrorWithCode(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

function createHelperError(code) {
  const error = new Error("Anchored project file operation failed.");
  error.code = code;
  return error;
}

function sendFailure(error) {
  sendMessage({ type: "error", code: readErrorCode(error) });
}

function readErrorCode(error) {
  if (!isErrorWithCode(error) || typeof error.code !== "string") return "EIO";
  return error.code;
}

function sendMessage(message) {
  process.send?.(message);
}

function disconnectHelper() {
  process.disconnect?.();
}
