import { useEffect, useRef } from 'react'

interface GNode {
  id: number; label: string; color: string; size: number
  x: number; y: number; vx: number; vy: number
}

// Universal email world — entities everyone recognises in their inbox
const NODE_DEFS: Omit<GNode, 'x' | 'y' | 'vx' | 'vy'>[] = [
  { id:  0, label: 'Amazon',        color: '#818cf8', size: 26 },
  { id:  1, label: 'Netflix',       color: '#818cf8', size: 20 },
  { id:  2, label: 'LinkedIn',      color: '#818cf8', size: 22 },
  { id:  3, label: 'PayPal',        color: '#818cf8', size: 20 },
  { id:  4, label: 'Google',        color: '#818cf8', size: 24 },
  { id:  5, label: 'Zoom',          color: '#818cf8', size: 18 },
  { id:  6, label: 'Dropbox',       color: '#818cf8', size: 16 },
  { id:  7, label: 'Apple',         color: '#818cf8', size: 20 },
  { id:  8, label: 'Sarah Johnson', color: '#10b981', size: 17 },
  { id:  9, label: 'James Miller',  color: '#10b981', size: 15 },
  { id: 10, label: 'Emma Clarke',   color: '#10b981', size: 16 },
  { id: 11, label: 'Invoice #4821', color: '#f59e0b', size: 14 },
  { id: 12, label: 'Annual Plan',   color: '#f59e0b', size: 16 },
  { id: 13, label: 'Receipt',       color: '#f59e0b', size: 14 },
  { id: 14, label: 'Subscriptions', color: '#f43f5e', size: 28 },
  { id: 15, label: 'Finance',       color: '#f43f5e', size: 26 },
  { id: 16, label: 'Work',          color: '#f43f5e', size: 22 },
  { id: 17, label: 'New York',      color: '#14b8a6', size: 13 },
  { id: 18, label: 'London',        color: '#14b8a6', size: 13 },
  { id: 19, label: 'Q4 Planning',   color: '#f97316', size: 15 },
  { id: 20, label: 'HDFC Bank',     color: '#818cf8', size: 22 },
  { id: 21, label: 'Swiggy',        color: '#818cf8', size: 15 },
  { id: 22, label: 'Spotify',       color: '#818cf8', size: 18 },
  { id: 23, label: 'Microsoft',     color: '#818cf8', size: 21 },
  { id: 24, label: 'Paytm',         color: '#818cf8', size: 17 },
  { id: 25, label: 'Uber',          color: '#818cf8', size: 16 },
  { id: 26, label: 'Flipkart',      color: '#818cf8', size: 19 },
  { id: 27, label: 'Slack',         color: '#818cf8', size: 16 },
  { id: 28, label: 'Statement',     color: '#f59e0b', size: 13 },
  { id: 29, label: 'Travel',        color: '#f43f5e', size: 20 },
  { id: 30, label: 'Alex Turner',   color: '#10b981', size: 14 },
  { id: 31, label: 'Mumbai',        color: '#14b8a6', size: 13 },
]

const EDGES: [number, number][] = [
  [0, 13], [0, 15], [0, 17],
  [1, 12], [1, 14],
  [3, 11], [3, 15],
  [4, 16], [4, 18],
  [5, 19], [5, 16],
  [6, 14], [7, 12], [7, 14],
  [8, 19], [9, 19], [10, 16],
  [8, 10], [9, 10],
  [2, 8],  [2, 16],
  [12, 14],[11, 15],[13, 15],
  [20, 15],[20, 11],
  [21, 17],[6, 12],
  [22, 14],[22, 12],
  [23, 16],[23, 27],
  [24, 15],[24, 28],
  [25, 29],[25, 17],
  [26, 13],[26, 14],
  [27, 16],[27, 19],
  [28, 20],[28, 15],
  [29, 18],[29, 31],
  [30, 16],[30, 19],
  [31, 29],[21, 31],
]

export default function KnowledgeGraph({ className, noDotGrid }: { className?: string; noDotGrid?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let dpr = window.devicePixelRatio || 1
    let w = 0, h = 0, cx = 0, cy = 0, tick = 0, rafId = 0

    const nodes: GNode[] = NODE_DEFS.map(n => ({ ...n, x: 0, y: 0, vx: 0, vy: 0 }))

    function scatter() {
      // Bias initial placement to the right 60% — keeps nodes out of the text column
      const startX = w * 0.40
      const availW = w * 0.60
      const cols = Math.ceil(Math.sqrt(nodes.length * (availW / h)))
      const rows = Math.ceil(nodes.length / cols)
      nodes.forEach((n, i) => {
        const col = i % cols, row = Math.floor(i / cols)
        const jx = (Math.random() - 0.5) * (availW / cols) * 0.7
        const jy = (Math.random() - 0.5) * (h / rows) * 0.7
        n.x = startX + (availW / (cols + 1)) * (col + 1) + jx
        n.y = (h / (rows + 1)) * (row + 1) + jy
        n.vx = (Math.random() - 0.5) * 1.2
        n.vy = (Math.random() - 0.5) * 1.2
      })
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      dpr = window.devicePixelRatio || 1
      w = rect.width; h = rect.height; cx = w / 2; cy = h / 2
      canvas!.width  = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      ctx!.scale(dpr, dpr)
      scatter()
      tick = 0
    }

    function physics() {
      // Low gravity + high repulsion = nodes spread wide across the full canvas
      const REPULSION = 22000
      const K         = 0.003
      const IDEAL     = 220
      const G         = 0.00025  // very weak gravity — wall clamping prevents drift
      const FRICTION  = tick < 120 ? 0.88 : 0.97

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x
          const dy = nodes[j].y - nodes[i].y
          const d2 = Math.max(dx * dx + dy * dy, 1)
          const d  = Math.sqrt(d2)
          const f  = (REPULSION / d2) * 0.016
          const fx = (dx / d) * f, fy = (dy / d) * f
          nodes[i].vx -= fx; nodes[i].vy -= fy
          nodes[j].vx += fx; nodes[j].vy += fy
        }
      }
      for (const [si, ti] of EDGES) {
        const s = nodes[si], t = nodes[ti]
        const dx = t.x - s.x, dy = t.y - s.y
        const d  = Math.sqrt(dx * dx + dy * dy) || 1
        const f  = (d - IDEAL) * K
        const fx = (dx / d) * f, fy = (dy / d) * f
        s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy
      }
      const gravityCX = w * 0.68  // pull toward right side, away from text column
      for (const n of nodes) {
        n.vx += (gravityCX - n.x) * G; n.vy += (cy - n.y) * G
        n.vx *= FRICTION; n.vy *= FRICTION
        n.x += n.vx; n.y += n.vy
        // Hard left boundary keeps nodes clear of the text column (~38% from left)
        const leftBound = Math.max(n.size + 60, w * 0.38)
        const padX = n.size + 60
        const padY = n.size + 18
        n.x = Math.max(leftBound, Math.min(w - padX, n.x))
        n.y = Math.max(padY, Math.min(h - padY, n.y))
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h)
      const t = tick * 0.013

      // Dot grid — skip when parent CSS already provides one (hero section)
      if (!noDotGrid) {
        ctx!.save()
        ctx!.fillStyle = 'rgba(129,140,248,0.06)'
        const gs = 52
        for (let gx = gs; gx < w; gx += gs)
          for (let gy = gs; gy < h; gy += gs) {
            ctx!.beginPath(); ctx!.arc(gx, gy, 0.9, 0, Math.PI * 2); ctx!.fill()
          }
        ctx!.restore()
      }

      // Edges
      for (const [si, ti] of EDGES) {
        const s = nodes[si], tn = nodes[ti]
        const mx = (s.x + tn.x) / 2
        const my = (s.y + tn.y) / 2 - Math.abs(s.x - tn.x) * 0.12
        ctx!.save()
        ctx!.beginPath()
        ctx!.moveTo(s.x, s.y)
        ctx!.quadraticCurveTo(mx, my, tn.x, tn.y)
        ctx!.strokeStyle = 'rgba(129,140,248,0.18)'
        ctx!.lineWidth = 0.8
        ctx!.stroke()
        ctx!.restore()
      }

      // Nodes
      for (const n of nodes) {
        const pulse = 1 + 0.028 * Math.sin(t * 1.5 + n.id * 0.79)
        const sz = n.size * pulse

        // Glow halo
        const grd = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, sz * 2.6)
        grd.addColorStop(0, n.color + '38')
        grd.addColorStop(1, n.color + '00')
        ctx!.save(); ctx!.fillStyle = grd
        ctx!.beginPath(); ctx!.arc(n.x, n.y, sz * 2.6, 0, Math.PI * 2); ctx!.fill(); ctx!.restore()

        // Circle
        ctx!.save()
        ctx!.shadowColor = n.color; ctx!.shadowBlur = 12
        ctx!.fillStyle = n.color
        ctx!.beginPath(); ctx!.arc(n.x, n.y, sz, 0, Math.PI * 2); ctx!.fill(); ctx!.restore()

        // Label
        ctx!.save()
        ctx!.font = '500 10px -apple-system, system-ui, sans-serif'
        ctx!.textAlign = 'center'; ctx!.textBaseline = 'top'
        ctx!.fillStyle = '#dde6f4'
        ctx!.shadowColor = 'rgba(0,0,0,0.95)'; ctx!.shadowBlur = 7
        ctx!.fillText(n.label, n.x, n.y + sz + 7); ctx!.restore()
      }
    }

    function frame() { tick++; physics(); draw(); rafId = requestAnimationFrame(frame) }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()
    rafId = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(rafId); ro.disconnect() }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
