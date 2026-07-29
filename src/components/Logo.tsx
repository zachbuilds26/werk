/**
 * Werk logo — the supplied mark (a light-blue ascending three-bar glyph: one
 * request rising into the whole package) set beside the brand wordmark in
 * Bricolage Grotesque. The mark is a PNG in /public; the wordmark stays live
 * text so it inherits the brand font and colour.
 */
export default function Logo({ className }: { className?: string }) {
  return (
    <span className={`brand__lockup${className ? ` ${className}` : ""}`}>
      <img src="/werk-mark.png" alt="" className="brand__mark" aria-hidden="true" />
      <span className="brand__word">Werk</span>
    </span>
  )
}
