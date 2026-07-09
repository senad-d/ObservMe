import { isAbsolute, join, relative, resolve } from "node:path";

export interface ProjectLocalFilePathOptions {
  readonly cwd?: string;
  readonly configDirName?: string;
  readonly defaultConfigDirName?: string;
  readonly fileName: string;
  readonly overridePath?: string;
  readonly inputLabel: string;
}

const parentSegment = "..";

export function resolveProjectLocalFilePath(options: ProjectLocalFilePathOptions): string {
  const root = resolve(options.cwd ?? process.cwd());
  const candidatePath = resolveProjectLocalCandidatePath(root, options);

  if (!isPathInsideOrSame(root, candidatePath)) throw new Error(createUnsafeProjectPathMessage(options.inputLabel));
  if (shouldPreserveRelativeOverride(options)) return options.overridePath!;
  return candidatePath;
}

function resolveProjectLocalCandidatePath(root: string, options: ProjectLocalFilePathOptions): string {
  if (options.overridePath !== undefined) return resolveOverridePath(root, options.overridePath, options.inputLabel);
  return resolveConfigDirPath(root, options);
}

function shouldPreserveRelativeOverride(options: ProjectLocalFilePathOptions): boolean {
  return options.cwd === undefined && options.overridePath !== undefined && !isAbsolute(options.overridePath);
}

function resolveOverridePath(root: string, overridePath: string, inputLabel: string): string {
  if (isRelativeTraversalPath(overridePath)) throw new Error(createUnsafeProjectPathMessage(inputLabel));
  return isAbsolute(overridePath) ? resolve(overridePath) : resolve(root, overridePath);
}

function resolveConfigDirPath(root: string, options: ProjectLocalFilePathOptions): string {
  const configDirName = options.configDirName ?? options.defaultConfigDirName;

  if (!configDirName) throw new Error(createUnsafeProjectPathMessage(options.inputLabel));
  if (isAbsolute(configDirName)) throw new Error(createUnsafeProjectPathMessage(options.inputLabel));
  if (hasParentSegment(configDirName)) throw new Error(createUnsafeProjectPathMessage(options.inputLabel));
  return resolve(root, join(configDirName, options.fileName));
}

function isRelativeTraversalPath(pathInput: string): boolean {
  return !isAbsolute(pathInput) && hasParentSegment(pathInput);
}

function hasParentSegment(pathInput: string): boolean {
  return pathInput.split(/[\\/]+/u).includes(parentSegment);
}

function isPathInsideOrSame(root: string, candidatePath: string): boolean {
  const pathFromRoot = relative(root, candidatePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(parentSegment) && !isAbsolute(pathFromRoot));
}

function createUnsafeProjectPathMessage(inputLabel: string): string {
  return `Unsafe ObservMe ${inputLabel}: path input must stay inside the active project root.`;
}
