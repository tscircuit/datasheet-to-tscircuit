import { resolve } from "node:path"

export const serverDirectory = resolve(import.meta.dir, "..")
export const repositoryRoot = resolve(serverDirectory, "../..")
