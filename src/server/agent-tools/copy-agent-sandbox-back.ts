import { cp, readdir } from "node:fs/promises"
import { join } from "node:path"

export async function copyAgentSandboxBack(input: {
  sandboxDirectory: string
  originalDirectory: string
}): Promise<void> {
  for (const entry of await readdir(input.sandboxDirectory, { withFileTypes: true })) {
    await cp(join(input.sandboxDirectory, entry.name), join(input.originalDirectory, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    })
  }
}
