export function readCliOption(args: string[], name: string): string {
  const index = args.indexOf(name)
  const option = index < 0 ? undefined : args[index + 1]
  if (!option || option.startsWith("--")) throw new Error(`${name} requires a value`)
  return option
}
