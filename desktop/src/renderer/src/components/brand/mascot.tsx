/**
 * The Miss Minutes mascot (04a·T3), drawn as code in a 1930s rubber-hose style: a flat orange clock-face disc with a
 * darker coin-edge rim, hour ticks, a centre-pivot "nose", tall lashed eyes, thin orange arms with ringed cuffs,
 * four-finger white gloves, stick legs and round shoes. Thin, even outlines and a limited palette keep it clean.
 * Drawn from scratch (no traced or bundled artwork). Personal use only, see the 04a risks.
 *
 * Fixed brand colours live here on purpose (brand art is the one place hex values are allowed in .tsx).
 * scripts/build-icons.mjs renders this component to resources/brand/mascot.svg, so keep it free of renderer-only imports.
 */
import type { JSX } from 'react'

export type MascotPose = 'wave' | 'busy' | 'cheer' | 'worried' | 'point' | 'sleep'

const INK = '#3B2416'
const ORANGE = '#F29A32'
const RIM = '#D2691E'
const EYE = '#FFF8EC'
const PUPIL = '#2A1B22'
const MOUTH = '#6B2A12'
const GLOVE = '#FFFFFF'
const SCREEN = '#F3E3C3'
/** Legs and Zzz sit on the page background: theme.css lightens them in CRT mode. */
const LIMB = 'var(--mascot-limb, #3B2416)'

// The disc: front face centre and radii. The rim is the same ellipse shifted left (the coin's edge).
const CX = 100
const CY = 104
const RX = 66
const RY = 70

type Pt = readonly [number, number]
type GloveKind = 'open' | 'point' | 'fist'

interface ArmArt {
  shoulder: Pt
  control: Pt
  hand: Pt
  glove: GloveKind
}

interface PoseArt {
  left: ArmArt
  right: ArmArt
  /** Pupil offset inside the eye. */
  look: Pt
  mouth: 'smile' | 'grin' | 'o' | 'rest' | 'set'
  eyesClosed?: boolean
}

const POSES: Record<MascotPose, PoseArt> = {
  wave: {
    left: { shoulder: [44, 122], control: [18, 140], hand: [24, 166], glove: 'fist' },
    right: { shoulder: [156, 118], control: [190, 112], hand: [184, 74], glove: 'point' },
    look: [0, -3],
    mouth: 'smile'
  },
  busy: {
    left: { shoulder: [44, 124], control: [12, 138], hand: [32, 156], glove: 'fist' },
    right: { shoulder: [156, 124], control: [188, 138], hand: [168, 156], glove: 'fist' },
    look: [4, 2],
    mouth: 'set'
  },
  cheer: {
    left: { shoulder: [44, 112], control: [14, 98], hand: [22, 64], glove: 'open' },
    right: { shoulder: [156, 112], control: [186, 98], hand: [178, 64], glove: 'open' },
    look: [0, -4],
    mouth: 'grin'
  },
  worried: {
    left: { shoulder: [44, 120], control: [14, 122], hand: [26, 92], glove: 'open' },
    right: { shoulder: [156, 120], control: [186, 122], hand: [174, 92], glove: 'open' },
    look: [0, -5],
    mouth: 'o'
  },
  point: {
    left: { shoulder: [44, 122], control: [18, 140], hand: [24, 166], glove: 'fist' },
    right: { shoulder: [156, 120], control: [186, 126], hand: [200, 114], glove: 'point' },
    look: [5, -1],
    mouth: 'o'
  },
  sleep: {
    left: { shoulder: [44, 124], control: [26, 150], hand: [38, 168], glove: 'fist' },
    right: { shoulder: [156, 124], control: [174, 150], hand: [162, 168], glove: 'fist' },
    look: [0, 0],
    mouth: 'rest',
    eyesClosed: true
  }
}

const round = (n: number): number => Math.round(n * 100) / 100

/** Point on the face ellipse at `deg` (0 = 3 o'clock, 90 = 6 o'clock), scaled by `k`. */
function onFace(deg: number, k: number): Pt {
  const a = (deg * Math.PI) / 180
  return [round(CX + RX * k * Math.cos(a)), round(CY + RY * k * Math.sin(a))]
}

function Ticks(): JSX.Element {
  const marks = Array.from({ length: 12 }, (_, i) => {
    const major = i % 3 === 0
    const [x1, y1] = onFace(i * 30, 0.9)
    const [x2, y2] = onFace(i * 30, major ? 0.72 : 0.8)
    return (
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={INK}
        strokeWidth={major ? 4.5 : 2}
        strokeLinecap="round"
      />
    )
  })
  return <>{marks}</>
}

/** Fingers and thumb as [x1, y1, x2, y2] in glove space: wrist at 0,0, hand pointing +x. */
const FINGERS: Record<GloveKind, number[][]> = {
  open: [
    [12, -4, 22, -9],
    [13, -1, 25, -2],
    [13, 3, 23, 6],
    [6, -5, 8, -12]
  ],
  point: [
    [12, -3, 28, -4],
    [12, 1, 16, 4],
    [11, 4, 14, 7],
    [6, -5, 10, -10]
  ],
  fist: [
    [12, -3, 16, -4],
    [12, 1, 16, 1.5],
    [11, 4, 15, 5],
    [6, -5, 9, -9]
  ]
}

/** A thin orange sleeve with two cuff rings, ending in a white four-finger glove. */
/** The glove is drawn separately (Glove) so raised hands can sit in front of the disc. */
function Arm({ arm }: { arm: ArmArt }): JSX.Element {
  const [sx, sy] = arm.shoulder
  const [cx, cy] = arm.control
  const [hx, hy] = arm.hand
  const d = `M${sx} ${sy} Q${cx} ${cy} ${hx} ${hy}`
  const len = Math.hypot(hx - cx, hy - cy)
  const [ux, uy] = [(hx - cx) / len, (hy - cy) / len]
  const ring = (back: number): string => {
    const [px, py] = [hx - ux * back, hy - uy * back]
    return `M${round(px - uy * 3.6)} ${round(py + ux * 3.6)} L${round(px + uy * 3.6)} ${round(py - ux * 3.6)}`
  }
  return (
    <g>
      <path d={d} fill="none" stroke={INK} strokeWidth={8} strokeLinecap="round" />
      <path d={d} fill="none" stroke={ORANGE} strokeWidth={4.6} strokeLinecap="round" />
      <path d={`${ring(3)} ${ring(7)}`} stroke={INK} strokeWidth={1.6} strokeLinecap="round" />
    </g>
  )
}

function Glove({ arm, flip }: { arm: ArmArt; flip: boolean }): JSX.Element {
  const [cx, cy] = arm.control
  const [hx, hy] = arm.hand
  const angle = round((Math.atan2(hy - cy, hx - cx) * 180) / Math.PI)
  const fingers = FINGERS[arm.glove]
    .map(([x1, y1, x2, y2]) => `M${x1} ${y1} L${x2} ${y2}`)
    .join(' ')
  return (
    <g transform={`translate(${hx} ${hy}) rotate(${angle}) scale(1.55 ${flip ? -1.55 : 1.55})`}>
      <path d={fingers} stroke={INK} strokeWidth={5.6} strokeLinecap="round" />
      <ellipse cx={8.5} cy={0} rx={7.6} ry={6.4} fill={GLOVE} stroke={INK} strokeWidth={1.3} />
      <path d={fingers} stroke={GLOVE} strokeWidth={3} strokeLinecap="round" />
    </g>
  )
}

/** Tall eye with a big pupil and three lashes on its outer top edge. */
function Eye({
  cx,
  side,
  look,
  closed
}: {
  cx: number
  side: -1 | 1
  look: Pt
  closed?: boolean
}): JSX.Element {
  const cy = 86
  const lash = (x1: number, y1: number, x2: number, y2: number): string =>
    `M${round(cx + side * x1)} ${y1} L${round(cx + side * x2)} ${y2}`
  if (closed)
    return (
      <path
        d={`M${cx - 14} 90 Q${cx} 99 ${cx + 14} 90 ${lash(10, 94, 15, 99)} ${lash(5, 96, 8, 102)} ${lash(0, 96.8, 1, 103)}`}
        fill="none"
        stroke={INK}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    )
  const [dx, dy] = look
  // Three lashes on the outer-top arc of the eye ellipse (rx 15, ry 22); `side` mirrors them outward.
  const lashes = [214, 238, 262]
    .map((deg) => {
      const a = (deg * Math.PI) / 180
      const [ox, oy] = [Math.cos(a), Math.sin(a)]
      return lash(-15 * ox, round(cy + 22 * oy), -23 * ox, round(cy + 22 * oy + 9 * oy))
    })
    .join(' ')
  return (
    <g>
      <path d={lashes} stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
      <ellipse cx={cx} cy={cy} rx={15} ry={22} fill={EYE} stroke={INK} strokeWidth={2.2} />
      <ellipse cx={cx + dx} cy={cy + 4 + dy} rx={8.5} ry={13} fill={PUPIL} />
      <ellipse cx={cx + dx + 3} cy={cy - 3 + dy} rx={2.4} ry={3.4} fill={EYE} />
    </g>
  )
}

function Mouth({ kind }: { kind: PoseArt['mouth'] }): JSX.Element {
  const line = { fill: 'none', stroke: INK, strokeWidth: 2.4, strokeLinecap: 'round' as const }
  switch (kind) {
    case 'smile':
      return (
        <g>
          <path
            d="M80 126 Q100 146 122 124 Q100 131 80 126 Z"
            fill={MOUTH}
            stroke={INK}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <path d="M83 127 Q100 131.5 119 125.5 Q101 139 83 127 Z" fill={GLOVE} />
        </g>
      )
    case 'grin':
      return (
        <g>
          <path
            d="M82 123 Q100 152 120 123 Q100 130 82 123 Z"
            fill={MOUTH}
            stroke={INK}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <path d="M85 125 Q100 131 117 125 Q101 135 85 125 Z" fill={GLOVE} />
        </g>
      )
    case 'o':
      return (
        <ellipse cx={100} cy={131} rx={5.5} ry={6.5} fill={MOUTH} stroke={INK} strokeWidth={2} />
      )
    case 'rest':
      return <path d="M92 130 Q100 134 108 130" {...line} />
    case 'set':
      return <path d="M88 127 Q100 136 113 126" {...line} />
  }
}

/** A generic browser window (not any real browser's logo), for the "sign in" pose. */
function BrowserGlyph(): JSX.Element {
  return (
    <g transform="translate(224 96)">
      <rect width={34} height={30} rx={4} fill={SCREEN} stroke={INK} strokeWidth={2.4} />
      <path d="M0 9 H34" stroke={INK} strokeWidth={2.4} />
      <circle cx={6} cy={4.5} r={1.5} fill={INK} />
      <circle cx={11} cy={4.5} r={1.5} fill={INK} />
      <circle cx={17} cy={20} r={6} fill="none" stroke={RIM} strokeWidth={2.2} />
      <path d="M11 20 H23 M17 14 V26" stroke={RIM} strokeWidth={1.8} />
    </g>
  )
}

function Zzz(): JSX.Element {
  const z = {
    fill: 'none',
    stroke: LIMB,
    strokeWidth: 2.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  return (
    <g>
      <path d="M162 22 h10 l-10 12 h10" {...z} />
      <path d="M178 6 h7 l-7 8 h7" {...z} strokeWidth={2} />
    </g>
  )
}

/** A rounded cartoon shoe, ankle at 0,0, toe pointing left. */
const SHOE = 'M5 -4 C7 3 6.5 9 1 9 L-15 9 C-22 9 -22.5 -1 -16 -3 C-11 -4.5 -6 -4 -2 -6 Z'

export interface MascotProps {
  pose?: MascotPose
  /** Rendered width in px (height follows the aspect ratio). */
  size?: number
  className?: string
  /** Accessible name. Omit for a decorative mascot (then it is hidden from screen readers). */
  title?: string
}

export function Mascot({ pose = 'wave', size = 120, className, title }: MascotProps): JSX.Element {
  const art = POSES[pose]
  const width = pose === 'point' ? 262 : 200
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} 226`}
      width={(size * width) / 200}
      height={(size * 226) / 200}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-pose={pose}
    >
      {title && <title>{title}</title>}
      {/* legs + shoes, behind the disc */}
      <path
        d="M90 168 Q87 190 86 206 M110 168 Q113 190 114 206"
        fill="none"
        stroke={LIMB}
        strokeWidth={2.8}
        strokeLinecap="round"
      />
      <path
        d={SHOE}
        transform="translate(86 207)"
        fill={ORANGE}
        stroke={INK}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d={SHOE}
        transform="translate(114 207) scale(-1 1)"
        fill={ORANGE}
        stroke={INK}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {/* arms emerge from behind the disc */}
      <Arm arm={art.left} />
      <g
        className={pose === 'wave' ? 'animate-wave' : undefined}
        style={pose === 'wave' ? { transformOrigin: '156px 118px' } : undefined}
      >
        <Arm arm={art.right} />
        <Glove arm={art.right} flip={false} />
      </g>
      <Glove arm={art.left} flip />
      {/* the disc: rim (coin edge) then face */}
      <ellipse cx={CX - 7} cy={CY + 1} rx={RX} ry={RY} fill={RIM} stroke={INK} strokeWidth={2.4} />
      <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill={ORANGE} stroke={INK} strokeWidth={2.4} />
      <g
        className={pose === 'busy' ? 'motion-safe:animate-[sweep_8s_linear_infinite]' : undefined}
        style={pose === 'busy' ? { transformOrigin: `${CX}px ${CY}px` } : undefined}
      >
        <Ticks />
      </g>
      <Eye cx={79} side={-1} look={art.look} closed={art.eyesClosed} />
      <Eye cx={121} side={1} look={art.look} closed={art.eyesClosed} />
      <circle cx={CX} cy={108} r={3.6} fill={INK} />
      <Mouth kind={art.mouth} />
      {/* raised hands sit in front of the disc edge */}
      {(pose === 'cheer' || pose === 'worried') && (
        <>
          <Glove arm={art.left} flip />
          <Glove arm={art.right} flip={false} />
        </>
      )}
      {pose === 'point' && <BrowserGlyph />}
      {pose === 'sleep' && <Zzz />}
    </svg>
  )
}
