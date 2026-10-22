/** A short job title from a goal: its first sentence (or line), whitespace collapsed, cut at a word boundary to `max` characters. */
export function jobTitleFrom(text: string | null | undefined, max = 80): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat
  const one = sentence.replace(/[.!?]+$/, '')
  if (one.length <= max) return one
  const cut = one.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:-]+$/, '')
}
