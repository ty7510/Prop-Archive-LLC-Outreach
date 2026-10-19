// The one-at-a-time pop-ups show one item from a list that refreshes every 15 seconds. They follow
// the item on screen by its id, so a refresh that adds or drops people never swaps it for someone
// else (and Sent it never marks the wrong person). When the item leaves the list (sent or
// skipped), the next one in the same place comes up. Each opening starts at the top.
import { useEffect, useState } from 'react'

export function usePinnedIndex<T>(items: T[], idOf: (item: T) => string, open: boolean) {
  const [pinned, setPinned] = useState<string | null>(null)
  const [place, setPlace] = useState(0)
  const found = pinned === null ? -1 : items.findIndex((item) => idOf(item) === pinned)
  const at = found >= 0 ? found : Math.min(place, Math.max(0, items.length - 1))
  const current: T | undefined = items[at]
  const currentId = current === undefined ? null : idOf(current)

  useEffect(() => {
    if (currentId !== pinned) setPinned(currentId)
    if (at !== place) setPlace(at)
  }, [currentId, pinned, at, place])

  useEffect(() => {
    if (!open) {
      setPinned(null)
      setPlace(0)
    }
  }, [open])

  const go = (to: number) => {
    const next = items[to]
    if (next === undefined) return
    setPinned(idOf(next))
    setPlace(to)
  }
  return { at, current, go }
}
