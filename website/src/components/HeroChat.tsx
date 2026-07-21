import { useEffect, useRef } from 'react'

type Part = [string, string | null]
interface Demo { q: string; parts: Part[] }

const demos: Demo[] = [
  {
    q: 'Who sends me the most emails?',
    parts: [
      ['ET Money', 'hl'], [' is your top sender — ', null],
      ['8,972 emails', 'hl'], [' taking up ', null],
      ['17.54%', 'hl'], [' of your inbox and ', null],
      ['3.2 GB', 'hl-c'], [' of storage.', null],
    ],
  },
  {
    q: 'Which subscriptions can I clean up?',
    parts: [
      ['589 recurring senders', 'hl'], [' detected. Top candidates: ', null],
      ['Goibibo', 'hl'], [' (624 emails), ', null],
      ['Medium', 'hl'], [' (580), ', null],
      ['LinkedIn', 'hl'], [' (510). Select any to bulk-trash them.', null],
    ],
  },
  {
    q: "What's taking the most storage?",
    parts: [
      ['ICICI Bank', 'hl'], [' leads with ', null],
      ['1.8 GB', 'hl-c'], [' across ', null],
      ['2,341 emails', 'hl'], ['. Total inbox: ', null],
      ['9.1 GB', 'hl-c'], [' · ', null],
      ['51,159 emails', 'hl'], ['.', null],
    ],
  },
  {
    q: "Show emails I've never opened",
    parts: [
      ['14,221 unread emails', 'hl'], [' totaling ', null],
      ['2.1 GB', 'hl-c'], ['. Oldest unread: ', null],
      ['January 2019', 'hl'], ['. ICICI Bank leads with ', null],
      ['1,840 unread', 'hl-g'], [' messages.', null],
    ],
  },
]

const AVATAR_SVG = `<svg width="12" height="12" viewBox="0 0 28 28" fill="none">
  <path d="M14 14 L14 1.5 A12.5 12.5 0 0 1 26.5 14 Z" fill="#7c3aed"/>
  <path d="M14 14 L26.5 14 A12.5 12.5 0 0 1 7.1 24.3 Z" fill="#06b6d4"/>
  <path d="M14 14 L7.1 24.3 A12.5 12.5 0 0 1 1.5 14 Z" fill="#f59e0b"/>
  <path d="M14 14 L1.5 14 A12.5 12.5 0 0 1 14 1.5 Z" fill="#10b981"/>
</svg>`

export default function HeroChat() {
  const msgsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = msgsRef.current
    if (!wrap) return
    let stopped = false
    let idx = 0

    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

    const typeText = (setter: (s: string) => void, text: string, speed: number) =>
      new Promise<void>(res => {
        let i = 0
        const id = setInterval(() => {
          if (stopped) { clearInterval(id); res(); return }
          setter(text.slice(0, ++i))
          if (i >= text.length) { clearInterval(id); res() }
        }, speed)
      })

    async function runDemo(demo: Demo) {
      wrap.innerHTML = ''

      // User bubble
      const userEl = document.createElement('div')
      userEl.className = 'hc-user'
      wrap.appendChild(userEl)
      await typeText(s => { userEl.textContent = s }, demo.q, 36)
      if (stopped) return

      await sleep(380)
      if (stopped) return

      // Thinking indicator
      const thinkWrap = document.createElement('div')
      thinkWrap.className = 'hc-ai-wrap'
      const thinkAvatar = document.createElement('div')
      thinkAvatar.className = 'hc-avatar'
      thinkAvatar.innerHTML = AVATAR_SVG
      const thinkDots = document.createElement('div')
      thinkDots.className = 'hc-thinking'
      thinkDots.innerHTML = '<div class="hc-dot"></div><div class="hc-dot"></div><div class="hc-dot"></div>'
      thinkWrap.appendChild(thinkAvatar)
      thinkWrap.appendChild(thinkDots)
      wrap.appendChild(thinkWrap)
      await sleep(950)
      if (stopped) return
      wrap.removeChild(thinkWrap)

      // AI response
      const aiWrap = document.createElement('div')
      aiWrap.className = 'hc-ai-wrap'
      const aiAvatar = document.createElement('div')
      aiAvatar.className = 'hc-avatar'
      aiAvatar.innerHTML = AVATAR_SVG
      const aiMsg = document.createElement('div')
      aiMsg.className = 'hc-ai'
      aiWrap.appendChild(aiAvatar)
      aiWrap.appendChild(aiMsg)
      wrap.appendChild(aiWrap)

      for (const [text, cls] of demo.parts) {
        if (stopped) return
        if (cls) {
          const span = document.createElement('span')
          span.className = cls
          aiMsg.appendChild(span)
          await typeText(s => { span.textContent = s }, text, 16)
        } else {
          const node = document.createTextNode('')
          aiMsg.appendChild(node)
          await typeText(s => { node.textContent = s }, text, 13)
        }
      }

      await sleep(3400)
    }

    ;(async function loop() {
      while (!stopped) {
        await runDemo(demos[idx % demos.length])
        idx++
      }
    })()

    return () => { stopped = true }
  }, [])

  return (
    <div className="hc-box">
      {/* Header */}
      <div className="hc-head">
        <div className="hc-head-left">
          <div className="hc-head-icon">
            <svg width="14" height="14" viewBox="0 0 28 28" fill="none" aria-hidden>
              <path d="M14 14 L14 1.5 A12.5 12.5 0 0 1 26.5 14 Z" fill="#7c3aed"/>
              <path d="M14 14 L26.5 14 A12.5 12.5 0 0 1 7.1 24.3 Z" fill="#06b6d4"/>
              <path d="M14 14 L7.1 24.3 A12.5 12.5 0 0 1 1.5 14 Z" fill="#f59e0b"/>
              <path d="M14 14 L1.5 14 A12.5 12.5 0 0 1 14 1.5 Z" fill="#10b981"/>
            </svg>
          </div>
          <div>
            <div className="hc-head-title">InboxPie AI</div>
            <div className="hc-head-sub">Answers from your inbox · locally</div>
          </div>
        </div>
        <div className="hc-live">
          <span className="hc-live-dot" />
          Live demo
        </div>
      </div>

      {/* Messages */}
      <div className="hc-msgs" ref={msgsRef} />

      {/* Input bar */}
      <div className="hc-input-bar">
        <div className="hc-input-field">Ask your inbox anything…</div>
        <div className="hc-send-btn" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M4 10h12M10 4l6 6-6 6"/>
          </svg>
        </div>
      </div>
      <div className="hc-hint">
        <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="10" cy="10" r="8"/><path d="M10 6v4l3 3"/>
        </svg>
        Responses generated from your local email metadata
      </div>
    </div>
  )
}
