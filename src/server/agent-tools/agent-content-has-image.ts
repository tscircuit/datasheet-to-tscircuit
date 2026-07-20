export function agentContentHasImage(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) => typeof block === "object" && block !== null && "type" in block && block.type === "image",
    )
  )
}
