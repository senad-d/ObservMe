export type ObservMeNotificationLevel = "info" | "warning" | "error";

export interface ObservMeNotificationContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    notify?: (message: string, level?: ObservMeNotificationLevel) => Promise<void> | void;
  };
}

export function notifyBestEffort(
  ctx: ObservMeNotificationContext,
  message: string,
  level: ObservMeNotificationLevel,
): void {
  if (ctx.hasUI === false || !ctx.ui?.notify) return;

  try {
    void Promise.resolve(ctx.ui.notify(message, level)).catch(ignoreNotificationError);
  } catch {
    return;
  }
}

function ignoreNotificationError(): undefined {
  return undefined;
}
