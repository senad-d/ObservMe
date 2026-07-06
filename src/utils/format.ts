export function formatGreeting(name: string, punctuation = "!") {
  const trimmedName = name.trim() || "Pi user";
  const trimmedPunctuation = punctuation.trim() || "!";
  return `Hello, ${trimmedName}${trimmedPunctuation}`;
}
