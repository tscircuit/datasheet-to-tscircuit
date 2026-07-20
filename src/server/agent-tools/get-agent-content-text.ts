export function getAgentContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const contentText = content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n")
    .trim()
  return contentText ? contentText.slice(0, 4_000) : undefined
}
