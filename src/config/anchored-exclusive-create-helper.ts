export type AnchoredCreateCommand =
  | { readonly type: "abort" | "cancel" | "commit" }
  | { readonly type: "create"; readonly fileName: string }
  | { readonly type: "write"; readonly content: string };
