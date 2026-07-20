import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

export async function copyComponentIntoModelWorkspace(input: {
  job_dir: string
  model_dir: string
}): Promise<void> {
  const preserved_original = join(input.job_dir, "component.circuit.tsx")
  const source_file = (await Bun.file(preserved_original).exists())
    ? preserved_original
    : join(input.job_dir, "index.circuit.tsx")
  await copyFile(source_file, join(input.model_dir, "component.circuit.tsx"))
  const application_plan = join(input.job_dir, "typical-application-plan.json")
  if (await Bun.file(application_plan).exists()) {
    await copyFile(application_plan, join(input.model_dir, "typical-application-plan.json"))
  }
  for (const relative_path of [
    "typical-application.circuit.tsx",
    join("dist", "typical-application", "circuit.json"),
  ]) {
    const source = join(input.job_dir, relative_path)
    if (!(await Bun.file(source).exists())) continue
    const destination = join(input.model_dir, relative_path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
}
