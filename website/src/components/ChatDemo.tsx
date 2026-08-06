import { useEffect, useRef, useState } from 'react'

const QUESTION = 'How much did I invest across all accounts last year?'

type Phase = 'typing' | 'thinking' | 'answering' | 'done'

export default function ChatDemo() {
  const [displayedQ, setDisplayedQ]       = useState('')
  const [phase, setPhase]                  = useState<Phase>('typing')
  const [showTotal, setShowTotal]          = useState(false)
  const [showRows, setShowRows]            = useState(false)
  const [showSource, setShowSource]        = useState(false)
  const startedRef                         = useRef(false)
  const timerRefs                          = useRef<ReturnType<typeof setTimeout>[]>([])

  function later(ms: number, fn: () => void) {
    const id = setTimeout(fn, ms)
    timerRefs.current.push(id)
    return id
  }

  function runSequence() {
    let i = 0
    function typeNext() {
      if (i >= QUESTION.length) {
        later(700, () => setPhase('thinking'))
        later(2000, () => {
          setPhase('answering')
          later(400,  () => setShowTotal(true))
          later(900,  () => setShowRows(true))
          later(1500, () => { setShowSource(true); setPhase('done') })
        })
        return
      }
      setDisplayedQ(QUESTION.slice(0, ++i))
      later(28 + Math.random() * 22, typeNext)
    }
    later(600, typeNext)
  }

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    runSequence()
    return () => { timerRefs.current.forEach(clearTimeout) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="chat-window">
      <div className="chat-titlebar">
        <div className="chat-dot" style={{ background: '#f43f5e' }} />
        <div className="chat-dot" style={{ background: '#f59e0b' }} />
        <div className="chat-dot" style={{ background: '#10b981' }} />
        <span className="chat-title-text">SmartSearch — Inbox &amp; Investments</span>
      </div>
      <div className="chat-body">
        {displayedQ && (
          <div className="chat-msg-user">
            {displayedQ}{phase === 'typing' ? <span style={{ opacity: 0.5 }}>|</span> : ''}
          </div>
        )}
        {phase === 'thinking' && (
          <div className="chat-thinking">
            <span /><span /><span />
          </div>
        )}
        {(phase === 'answering' || phase === 'done') && (
          <div className="chat-msg-ai">
            {showTotal && (
              <>
                <div className="ai-total grad-text">₹4,72,000 invested in 2024</div>
                <div className="ai-divider" />
              </>
            )}
            {showRows && (
              <div className="ai-rows">
                <div className="ai-row">
                  <span className="ai-row-label">HDFC Mutual Fund</span>
                  <span className="ai-row-val">₹2,10,000 · 18 SIPs</span>
                </div>
                <div className="ai-row">
                  <span className="ai-row-label">ET Money NPS</span>
                  <span className="ai-row-val">₹1,12,000 · 12 top-ups</span>
                </div>
                <div className="ai-row">
                  <span className="ai-row-label">Zerodha Stocks</span>
                  <span className="ai-row-val">₹1,50,000 · 34 trades</span>
                </div>
              </div>
            )}
            {showSource && (
              <div className="ai-source">
                <div className="ai-source-dot" />
                89 emails · Inbox &amp; Investments · Answered on your device · 1.4s
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
