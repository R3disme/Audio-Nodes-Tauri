import {
  Mic, Music, AppWindow, Volume2, Cable, Volume1, SlidersHorizontal, ChevronsDownUp,
  DoorClosed, Landmark, Repeat, Tornado, Zap, MoveHorizontal, Filter, BrickWall,
  ChevronsUpDown, Waves, Grid2x2, SlidersVertical, CircleDot, Square, type LucideIcon
} from 'lucide-react'

// One icon (+ optional short badge for types where the glyph alone is ambiguous)
// per node type — the single source for node headers, the sidebar palette and
// the guide. SVG icons inherit `currentColor`, so they tint with the surface
// they sit on (white header text, themed sidebar tiles, …).
export const NODE_ICONS: Record<string, { Icon: LucideIcon; badge?: string }> = {
  input:       { Icon: Mic },
  fileplayer:  { Icon: Music },
  application: { Icon: AppWindow },
  output:      { Icon: Volume2 },
  virtual:     { Icon: Cable },
  volume:      { Icon: Volume1 },
  eq:          { Icon: SlidersHorizontal, badge: 'EQ' },
  compressor:  { Icon: ChevronsDownUp, badge: 'COMP' },
  gate:        { Icon: DoorClosed, badge: 'GATE' },
  reverb:      { Icon: Landmark },
  delay:       { Icon: Repeat },
  chorus:      { Icon: Tornado },
  distortion:  { Icon: Zap },
  pan:         { Icon: MoveHorizontal },
  filter:      { Icon: Filter },
  limiter:     { Icon: BrickWall, badge: 'LIM' },
  expander:    { Icon: ChevronsUpDown, badge: 'EXP' },
  tremolo:     { Icon: Waves },
  bitcrusher:  { Icon: Grid2x2 },
  mixer:       { Icon: SlidersVertical },
  recorder:    { Icon: CircleDot }
}

export function nodeBadge(type: string): string | undefined {
  return NODE_ICONS[type]?.badge
}

export function NodeTypeIcon({ type, size = 12, className }: {
  type: string
  size?: number
  className?: string
}): JSX.Element {
  const Icon = NODE_ICONS[type]?.Icon ?? Square
  return <Icon size={size} strokeWidth={2.25} className={className} aria-hidden />
}
