import { join } from "node:path"
import { Point, resolveWorkspaceFile } from "./parse-benchmark-manifest"
import {
  readBenchmarkManifest,
  readCsvPoints,
  requireBenchmark,
  scoreBenchmark,
  transform,
} from "./score-single-model-benchmark"

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function downsamplePoints(points: Point[], maximum = 1_200): Point[] {
  if (points.length <= maximum) return points
  const stride = Math.ceil(points.length / maximum)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

function formatAxisValue(value: number): string {
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 10_000) return value.toExponential(2)
  return Number(value.toPrecision(4)).toString()
}

export async function renderModelBenchmarkComparisonSvg(input: {
  model_dir: string
  benchmark_id: string
  result_file_override?: string
}): Promise<string> {
  const { model_dir, benchmark_id, result_file_override } = input
  const manifest = await readBenchmarkManifest(model_dir)
  const benchmark = requireBenchmark(manifest, benchmark_id)
  const reference_points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
  const result_file = result_file_override ?? resolveWorkspaceFile(model_dir, benchmark.result_file)
  const result_points = await readCsvPoints(result_file)
  const score = await scoreBenchmark({
    model_dir,
    benchmark,
    options: { result_file_override: result_file },
  })
  const x_scale = benchmark.x_scale ?? "linear"
  const y_scale = benchmark.y_scale ?? "linear"
  const transformed_reference = reference_points.map((point) => ({
    x: transform({ value: point.x, scale: x_scale, label: "reference x" }),
    y: transform({ value: point.y, scale: y_scale, label: "reference y" }),
  }))
  const transformed_result = result_points.map((point) => ({
    x: transform({ value: point.x, scale: x_scale, label: "result x" }),
    y: transform({ value: point.y, scale: y_scale, label: "result y" }),
  }))
  const all_points = [...transformed_reference, ...transformed_result]
  const raw_x_min = Math.min(...all_points.map((point) => point.x))
  const raw_x_max = Math.max(...all_points.map((point) => point.x))
  const raw_y_min = Math.min(...all_points.map((point) => point.y))
  const raw_y_max = Math.max(...all_points.map((point) => point.y))
  const x_span = Math.max(raw_x_max - raw_x_min, Math.max(Math.abs(raw_x_min), 1) * 1e-9)
  const y_span = Math.max(raw_y_max - raw_y_min, Math.max(Math.abs(raw_y_min), 1) * 1e-9)
  const x_min = raw_x_min
  const y_min = raw_y_min - y_span * 0.08
  const y_max = raw_y_max + y_span * 0.08
  const width = 1_200
  const height = 720
  const left = 92
  const right = 34
  const top = 92
  const bottom = 78
  const plot_width = width - left - right
  const plot_height = height - top - bottom
  const mapX = (value: number) => left + ((value - x_min) / x_span) * plot_width
  const mapY = (value: number) => top + (1 - (value - y_min) / (y_max - y_min)) * plot_height
  const makePath = (points: Point[]) =>
    downsamplePoints(points)
      .map(
        (point, index) => `${index === 0 ? "M" : "L"}${mapX(point.x).toFixed(2)},${mapY(point.y).toFixed(2)}`,
      )
      .join(" ")
  const reference_path = makePath(transformed_reference)
  const result_path = makePath(transformed_result)
  const ticks = Array.from({ length: 6 }, (_, index) => index / 5)
  const x_ticks = ticks
    .map((ratio) => {
      const value = x_min + ratio * x_span
      const label_value = x_scale === "log" ? 10 ** value : value
      const x = mapX(value)
      return `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plot_height}" class="grid"/><text x="${x}" y="${top + plot_height + 30}" text-anchor="middle" class="tick">${escapeSvgText(formatAxisValue(label_value))}</text>`
    })
    .join("")
  const y_ticks = ticks
    .map((ratio) => {
      const value = y_min + ratio * (y_max - y_min)
      const label_value = y_scale === "log" ? 10 ** value : value
      const y = mapY(value)
      return `<line x1="${left}" y1="${y}" x2="${left + plot_width}" y2="${y}" class="grid"/><text x="${left - 14}" y="${y + 5}" text-anchor="end" class="tick">${escapeSvgText(formatAxisValue(label_value))}</text>`
    })
    .join("")
  const metrics = score.error_message
    ? score.error_message
    : `NRMSE ${((score.normalized_rmse ?? 0) * 100).toFixed(2)}% · maximum ${((score.normalized_max_error ?? 0) * 100).toFixed(2)}% · ${score.passed ? "PASS" : "FAIL"}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSvgText(benchmark.title)} reference and simulation comparison">
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; fill: #262626; }
    .title { font-size: 25px; font-weight: 700; }
    .subtitle { font-size: 14px; fill: #525252; }
    .tick { font-size: 13px; fill: #525252; }
    .axis-label { font-size: 15px; font-weight: 600; }
    .grid { stroke: #e5e5e5; stroke-width: 1; }
    .axis { stroke: #737373; stroke-width: 1.5; fill: none; }
    .reference { stroke: #2563eb; stroke-width: 3; fill: none; }
    .result { stroke: #16a34a; stroke-width: 3; fill: none; }
    .legend { font-size: 14px; font-weight: 600; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${left}" y="38" class="title">${escapeSvgText(benchmark.title)}</text>
  <text x="${left}" y="64" class="subtitle">${escapeSvgText(metrics)}</text>
  ${x_ticks}${y_ticks}
  <rect x="${left}" y="${top}" width="${plot_width}" height="${plot_height}" class="axis"/>
  <defs><clipPath id="plot"><rect x="${left}" y="${top}" width="${plot_width}" height="${plot_height}"/></clipPath></defs>
  <g clip-path="url(#plot)">
    <path d="${reference_path}" class="reference"/>
    <path d="${result_path}" class="result"/>
  </g>
  <line x1="${width - 300}" y1="42" x2="${width - 264}" y2="42" class="reference"/><text x="${width - 254}" y="47" class="legend">Datasheet reference</text>
  <line x1="${width - 300}" y1="66" x2="${width - 264}" y2="66" class="result"/><text x="${width - 254}" y="71" class="legend">Simulation result</text>
  <text x="${left + plot_width / 2}" y="${height - 23}" text-anchor="middle" class="axis-label">Time (ms)</text>
  <text x="24" y="${top + plot_height / 2}" text-anchor="middle" class="axis-label" transform="rotate(-90 24 ${top + plot_height / 2})">Output${y_scale === "log" ? " (log scale)" : ""}</text>
</svg>\n`
}
