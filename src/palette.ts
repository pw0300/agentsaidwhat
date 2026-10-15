export interface Command { id: string; label: string; detail: string; run: () => void }

/** Rank contiguous matches first, then ordered character matches. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  const direct = t.indexOf(q)
  if (direct >= 0) return 1000 - direct
  let cursor = 0
  let gap = 0
  for (const char of q) {
    const at = t.indexOf(char, cursor)
    if (at < 0) return -1
    gap += at - cursor
    cursor = at + 1
  }
  return Math.max(0, 500 - gap)
}

export function searchCommands(commands: Command[], query: string): Command[] {
  return commands.map((command, index) => ({ command, index, score: fuzzyScore(query, `${command.label} ${command.detail}`) }))
    .filter(x => x.score >= 0).sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.command)
}
