export function appendOtlpSignalPath(baseEndpoint: string, signalPath: string): string {
  const trimmedBaseEndpoint = removeTrailingSlashes(baseEndpoint);
  return `${trimmedBaseEndpoint}${signalPath}`;
}

function removeTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
