export function Brand({ on_home }: { on_home?: () => void }) {
  return (
    <a
      className="brand"
      href="/"
      aria-label="Datasheet to tscircuit home"
      onClick={(event) => {
        if (!on_home) return
        event.preventDefault()
        on_home()
      }}
    >
      <img src="/mark.svg" alt="" width="34" height="34" />
      <span className="brand-name">
        <strong>tscircuit</strong>
        <span className="brand-divider" />
        <span>datasheet agent</span>
      </span>
    </a>
  )
}
