import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export const OBSERVME_CONFIG_FILE_MAX_BYTES = 256 * 1024;
export const OBSERVME_ENV_FILE_MAX_BYTES = 128 * 1024;

const sourceTooLargeErrorCode = "OBSERVME_CONFIG_SOURCE_TOO_LARGE";
const sourceChangedErrorCode = "OBSERVME_CONFIG_SOURCE_CHANGED";

export async function readBoundedSourceFileText(path: string, maximumBytes: number): Promise<string> {
  let fileHandle: FileHandle | undefined;

  try {
    fileHandle = await open(path, createReadOpenFlags());
    return await readBoundedOpenSourceFileText(fileHandle, maximumBytes);
  } finally {
    await fileHandle?.close();
  }
}

export async function readBoundedOpenSourceFileText(
  fileHandle: FileHandle,
  maximumBytes: number,
): Promise<string> {
  const initialStats = await fileHandle.stat({ bigint: true });
  assertSupportedSourceFile(initialStats.isFile(), initialStats.size, maximumBytes);

  const expectedBytes = Number(initialStats.size);
  const content = Buffer.alloc(expectedBytes);
  let offset = 0;

  while (offset < expectedBytes) {
    const { bytesRead } = await fileHandle.read(content, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) throw createSourceChangedError();
    offset += bytesRead;
  }

  const finalStats = await fileHandle.stat({ bigint: true });
  if (!finalStats.isFile() || finalStats.size !== initialStats.size) throw createSourceChangedError();
  return content.toString("utf8");
}

export function isConfigSourceTooLargeError(error: unknown): boolean {
  return isErrorWithCode(error) && error.code === sourceTooLargeErrorCode;
}

function createReadOpenFlags(): number {
  return constants.O_RDONLY | optionalOpenFlag(constants.O_NONBLOCK);
}

function optionalOpenFlag(flag: number | undefined): number {
  return typeof flag === "number" ? flag : 0;
}

function assertSupportedSourceFile(isFile: boolean, size: bigint, maximumBytes: number): void {
  if (!isFile) throw createSourceChangedError();
  if (size > BigInt(maximumBytes)) throw createSourceTooLargeError();
}

function createSourceTooLargeError(): NodeJS.ErrnoException {
  const error = new Error("ObservMe configuration source exceeds the supported byte limit.") as NodeJS.ErrnoException;
  error.code = sourceTooLargeErrorCode;
  return error;
}

function createSourceChangedError(): NodeJS.ErrnoException {
  const error = new Error("ObservMe configuration source changed while it was being read.") as NodeJS.ErrnoException;
  error.code = sourceChangedErrorCode;
  return error;
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
