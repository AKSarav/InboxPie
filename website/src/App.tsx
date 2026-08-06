import { useEffect, useRef, useState } from 'react'
import KnowledgeGraph from './components/KnowledgeGraph'
import HeroChat from './components/HeroChat'

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLElement>(null)
  const [vis, setVis] = useState(false)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setVis(true); io.disconnect() }
    }, { threshold })
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return { ref, vis }
}

function Counter({ to, suffix = '' }: { to: number; suffix?: string }) {
  const [v, setV] = useState(0)
  const { ref, vis } = useInView(0.3)
  useEffect(() => {
    if (!vis) return
    let cur = 0
    const step = Math.ceil(to / 52)
    const id = setInterval(() => {
      cur = Math.min(cur + step, to); setV(cur)
      if (cur >= to) clearInterval(id)
    }, 20)
    return () => clearInterval(id)
  }, [vis, to])
  return <span ref={ref as React.Ref<HTMLSpanElement>}>{v.toLocaleString()}{suffix}</span>
}

function LogoMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="14" r="14" fill="url(#nlg)" />
      <path d="M7 9.5 L14 5.5 L21 9.5 L21 18.5 L14 22.5 L7 18.5 Z"
        stroke="#fff" strokeWidth="1.4" fill="none" opacity=".85" />
      <circle cx="14" cy="14" r="3" fill="#fff" opacity=".95" />
      <line x1="14" y1="14" x2="7"  y2="9.5"  stroke="#fff" strokeWidth=".9" opacity=".5" />
      <line x1="14" y1="14" x2="21" y2="9.5"  stroke="#fff" strokeWidth=".9" opacity=".5" />
      <line x1="14" y1="14" x2="21" y2="18.5" stroke="#fff" strokeWidth=".9" opacity=".5" />
      <line x1="14" y1="14" x2="14" y2="22.5" stroke="#fff" strokeWidth=".9" opacity=".5" />
      <line x1="14" y1="14" x2="7"  y2="18.5" stroke="#fff" strokeWidth=".9" opacity=".5" />
      <defs>
        <linearGradient id="nlg" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1"/><stop offset="1" stopColor="#8b5cf6"/>
        </linearGradient>
      </defs>
    </svg>
  )
}

function PieLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a78bfa"/><stop offset="100%" stopColor="#7c3aed"/>
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="13.5" fill="url(#pg)" opacity=".15"/>
      <path d="M14 14 L14 1.5 A12.5 12.5 0 0 1 26.5 14 Z" fill="#7c3aed"/>
      <path d="M14 14 L26.5 14 A12.5 12.5 0 0 1 7.1 24.3 Z" fill="#06b6d4"/>
      <path d="M14 14 L7.1 24.3 A12.5 12.5 0 0 1 1.5 14 Z" fill="#f59e0b"/>
      <path d="M14 14 L1.5 14 A12.5 12.5 0 0 1 14 1.5 Z" fill="#10b981"/>
      <circle cx="14" cy="14" r="5.5" fill="#0a0a0f"/>
    </svg>
  )
}

export default function App() {
  // Scroll-triggered fade-in for .fade-up elements
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>('.fade-up')
    const io = new IntersectionObserver(entries =>
      entries.forEach(e => { if (e.isIntersecting) { (e.target as HTMLElement).classList.add('in-view'); io.unobserve(e.target) } }),
      { threshold: 0.1 }
    )
    els.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])

  const featRef = useRef<HTMLElement>(null)

  return (
    <div className="page">

      {/* ── NAV ─────────────────────────────────────────────── */}
      <nav className="nav">
        <div className="nav-inner">
          <a className="nav-brand" href="#top"><PieLogo /> InboxPie</a>
          <div className="nav-links">
            <a href="#features">Features</a>
            <a href="#smartsearch">How It Works</a>
            <a href="#privacy">Privacy Promise</a>
            <a href="#apps">Download</a>
          </div>
          <div className="nav-right">
            <a className="nav-stars" href="https://github.com/AKSarav/InboxPie" target="_blank" rel="noreferrer">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#f59e0b" aria-hidden>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              Star on GitHub
            </a>
            <a className="nav-dl" href="#apps">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                <path d="M10 3v10M5 13l5 5 5-5"/><path d="M3 17h14"/>
              </svg>
              Download Free
            </a>
          </div>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────── */}
      <section className="hero" id="top">
        {/* Full-bleed animated graph — sits behind everything */}
        <KnowledgeGraph className="hero-graph-bg" noDotGrid />

        {/* Left-to-right fade so the text stays readable over the graph */}
        <div className="hero-overlay" aria-hidden />

        {/* Floating orbs */}
        <div className="hero-orbs" aria-hidden>
          <div className="hero-orb hero-orb-1" />
          <div className="hero-orb hero-orb-2" />
          <div className="hero-orb hero-orb-3" />
        </div>

        {/* Text content — floats on left, above graph */}
        <div className="hero-content">
          <h1 className="hero-h1">
            Are you fed up of <br />
            <span className="hero-accent">Time to InboxPie it</span>
          </h1>
          <p className="hero-sub">
            Visualize, Understand and ask questions — without sharing your data.
          </p>
          <div className="hero-actions">
            <a className="btn-primary" href="#apps">
              {/* Apple logo */}
              <svg width="14" height="15" viewBox="0 0 814 1000" fill="currentColor" aria-hidden>
                <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-42.4-155.5-127.4C46.7 790.7 0 663 0 541.8c0-207.5 135.4-317.3 269-317.3 70.1 0 128.4 46.4 172.5 46.4 42.1 0 108.6-49.6 187-49.6zm-41.2-169.9c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/>
              </svg>
              Download for Mac
            </a>
            <a className="btn-ghost" href="#apps">
              {/* Windows logo */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/>
              </svg>
              Download for Windows
            </a>
            <a className="btn-ghost" href="https://github.com/AKSarav/InboxPie" target="_blank" rel="noreferrer">
              {/* GitHub mark */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
              </svg>
              View on GitHub
            </a>
          </div>
          <div className="trust-row">
            <span className="trust-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" aria-hidden>
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
              </svg>
              Local
            </span>
            <span className="trust-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" aria-hidden>
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
              Open Source
            </span>
            <span className="trust-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" strokeWidth="2" aria-hidden>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
              </svg>
              No Cloud APIs
            </span>
            <span className="trust-badge">
              <svg width="13" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" aria-hidden>
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
              Privacy First
            </span>
          </div>
        </div>
      </section>

      {/* ── STATS BAND ───────────────────────────────────────── */}
      <div className="stats-band">
        <div className="stat-item">
          <span className="stat-num"><Counter to={0} suffix=" bytes" /></span>
          <span className="stat-label">sent to the cloud — ever</span>
        </div>
        <div className="stat-div" />
        <div className="stat-item">
          <span className="stat-num">∞</span>
          <span className="stat-label">emails indexed locally</span>
        </div>
        <div className="stat-div" />
        <div className="stat-item">
          <span className="stat-num"><Counter to={3} /></span>
          <span className="stat-label">products: App · Thunderbird · CLI</span>
        </div>
        <div className="stat-div" />
        <div className="stat-item">
          <span className="stat-num">You</span>
          <span className="stat-label">own your data and your keys</span>
        </div>
      </div>

      {/* ── PROBLEM SECTION ──────────────────────────────────── */}
      <section className="section" id="problem">
        <div className="container fade-up">
          <div className="section-eyebrow">Does this sound familiar?</div>
          <h2 className="section-title">
            Your inbox holds years of information.<br />But it's impossible to see it.
          </h2>
          <p className="section-sub">
            Most email clients show you a list. InboxPie shows you the picture.
          </p>
          <div className="problem-grid">
            <div className="problem-card fade-up">
              <div className="problem-icon">📥</div>
              <h3>Thousands of emails, zero visibility</h3>
              <p>
                You don't know who your biggest senders are, which subscriptions are flooding
                your inbox, or how your email volume has changed over time. Your client just shows
                a list — no summary, no breakdown, no patterns.
              </p>
            </div>
            <div className="problem-card fade-up">
              <div className="problem-icon">🔍</div>
              <h3>Finding something specific is painful</h3>
              <p>
                Looking for that flight booking from six months ago? An invoice for taxes? You need
                to remember exact words or sender names to find it. When you don't, it's gone in the
                noise of thousands of other messages.
              </p>
            </div>
            <div className="problem-card fade-up">
              <div className="problem-icon">🔒</div>
              <h3>Analytics tools want your data</h3>
              <p>
                Most email intelligence tools that understand your inbox well enough to be useful
                require uploading your messages to their servers. Your inbox contains financial
                records, personal conversations, and private information. That trade-off shouldn't
                be necessary.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── GALAXY SECTION (full-width) ────────────────────────
      <section className="galaxy-section" id="galaxy">
        <div className="galaxy-header fade-up">
          <div className="section-eyebrow" style={{ justifyContent: 'center' }}>Galaxy View</div>
          <h2 className="section-title" style={{ textAlign: 'center', marginBottom: 10 }}>
            See every relationship hiding in your inbox
          </h2>
          <p className="galaxy-sub">
            InboxPie maps senders, organisations, topics, products, and places into a live
            knowledge graph. Spot clusters, trace connections, filter by relationship type —
            and explore your inbox in a way a flat list never could.
          </p>
        </div>
        <div className="galaxy-canvas-wrap">
          <KnowledgeGraph className="galaxy-canvas" />
          <div className="galaxy-legend">
            <span className="leg" style={{ color: '#818cf8' }}>● Organisations</span>
            <span className="leg" style={{ color: '#10b981' }}>● People</span>
            <span className="leg" style={{ color: '#f59e0b' }}>● Documents</span>
            <span className="leg" style={{ color: '#f43f5e' }}>● Topics</span>
            <span className="leg" style={{ color: '#14b8a6' }}>● Places</span>
            <span className="leg" style={{ color: '#f97316' }}>● Events</span>
          </div>
        </div>
        <p className="galaxy-caption">
          Galaxy View is built into InboxPie. Runs entirely on your device.
        </p>
      </section> */}

      {/* ── FEATURES ─────────────────────────────────────────── */}
      <section className="section" id="features" ref={featRef as React.Ref<HTMLDivElement>}>
        <div className="container fade-up">
          <div className="section-eyebrow">What InboxPie gives you</div>
          <h2 className="section-title">Clear analytics for your entire inbox</h2>
          <p className="section-sub">
            Visual analytics and an AI layer — built for people with real, messy inboxes.
          </p>
          <div className="feat-grid">
            {[
              { icon: '🥧', title: 'PieView',           desc: 'Visual breakdown by sender, domain, folder, and size. Instantly see who and what fills your mailbox.' },
              { icon: '📊', title: 'Sender Analytics',   desc: 'Rank every sender by volume. Decide what to keep, unsubscribe from, or archive — with numbers to back you up.' },
              { icon: '📅', title: 'Timeline View',      desc: 'Chart email volume by day, week, or month. See when your inbox was busiest and how patterns have shifted.' },
              { icon: '📁', title: 'Folder Insights',    desc: 'Break down email distribution by folder. Understand how your archive is structured and where the bulk of messages live.' },
              { icon: '⚡', title: 'Bulk Actions',        desc: 'Move, archive, or delete selected emails in bulk straight from the analytics view. No more one-by-one scrolling.' },
              { icon: '🗺️', title: 'Knowledge Map',      desc: 'Your inbox grouped into categories you define — Finance, Travel, Work. Set keywords and the map reshapes to your taxonomy.' },
            ].map(f => (
              <div className="feat-card glass fade-up" key={f.title}>
                <div className="feat-icon">{f.icon}</div>
                <h3 className="feat-title">{f.title}</h3>
                <p className="feat-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SMARTSEARCH / AI ─────────────────────────────────── */}
      <section className="ai-section" id="smartsearch">
        <div className="ai-inner">
          <HeroChat />
          <div className="ai-copy fade-up">
            <div className="section-eyebrow">SmartSearch</div>
            <h2 className="section-title-left">Ask anything about your email</h2>
            <p className="ai-lead">
              InboxPie's on-device AI lets you ask plain-language questions about your inbox
              and get real answers — not a list of results to sort through yourself.
            </p>
            <ul className="ai-bullets">
              <li>Works with Ollama, Claude, OpenAI, and Gemini</li>
              <li>Reads subjects and senders — never message bodies by default</li>
              <li>Answers grounded in your actual email data</li>
              <li>All AI processing on your machine</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── PRIVACY ──────────────────────────────────────────── */}
      <section className="section privacy-section" id="privacy">
        <div className="container fade-up">
          <div className="section-eyebrow">Privacy Architecture</div>
          <h2 className="section-title">Built from the ground up to stay local</h2>
          <p className="section-sub">
            InboxPie has no servers, no accounts, and no telemetry. Everything is stored in
            a SQLite database on your own machine. Your email never leaves your device.
          </p>
          <div className="privacy-grid">
            <div className="privacy-flow glass">
              <h3 className="pflow-heading">How a scan works</h3>
              <p className="pflow-sub">Every step stays on your device</p>
              {[
                { n: '1', label: 'Read mailbox metadata', sub: 'Sender, subject, date, folder — not body content' },
                { n: '2', label: 'Build local index',     sub: 'Embeddings computed on-device, written to SQLite' },
                { n: '3', label: 'Extract knowledge graph', sub: 'LLM extracts entities and relationships locally' },
                { n: '4', label: 'You query, privately',  sub: 'SmartSearch runs locally. Zero data transmitted.' },
              ].map(s => (
                <div className="pflow-row" key={s.n}>
                  <div className="pflow-num">{s.n}</div>
                  <div>
                    <div className="pflow-label">{s.label}</div>
                    <div className="pflow-sub-text">{s.sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="privacy-cards">
              {[
                { icon: '🚫', title: 'Zero telemetry',     desc: 'No analytics endpoint, no crash reporter, no check-in. InboxPie collects nothing.' },
                { icon: '📵', title: 'No network calls',    desc: 'The scan engine makes no outbound connections. Email content never leaves your machine.' },
                { icon: '💾', title: 'Local storage only',  desc: 'Everything lives in a SQLite database in your home directory. You own and control it.' },
                { icon: '🔓', title: 'Open source',         desc: 'Every line of code that touches your email is readable on GitHub. No black boxes.' },
              ].map(c => (
                <div className="priv-card glass fade-up" key={c.title}>
                  <span className="priv-icon">{c.icon}</span>
                  <div>
                    <h3 className="priv-title">{c.title}</h3>
                    <p className="priv-desc">{c.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── PRODUCTS ─────────────────────────────────────────── */}
      <section className="section" id="apps">
        <div className="container fade-up">
          <div className="section-eyebrow">Three ways to use InboxPie</div>
          <h2 className="section-title">Pick the one that fits how you work</h2>
          <div className="products-grid">
            <div className="product-card glass fade-up featured">
              <div className="product-badge">Desktop App</div>
              <h3>macOS Desktop App</h3>
              <p>
                A native macOS app with the full visual dashboard — PieView, sender breakdowns,
                Galaxy View, SmartSearch, and bulk actions. Works with Apple Mail.
              </p>
              <div className="product-tags">
                <span>Apple Mail</span><span>macOS 13+</span><span>Native</span>
              </div>
              <a href="#" className="product-link">Download →</a>
            </div>
            <div className="product-card glass fade-up featured">
              <div className="product-badge">Add-on</div>
              <h3>Thunderbird Add-on</h3>
              <p>
                A full interactive dashboard inside Thunderbird itself. Move, delete, and analyse
                emails without leaving your mail client. PieView, timeline, bulk actions built in.
              </p>
              <div className="product-tags">
                <span>Thunderbird 115+</span><span>Cross-platform</span>
              </div>
              <a href="#" className="product-link">Add to Thunderbird →</a>
            </div>
            <div className="product-card glass fade-up">
              <div className="product-badge">CLI</div>
              <h3>Command-line Tool</h3>
              <p>
                Fast, scriptable scanner for Apple Mail. Generates HTML, CSV, JSON, and terminal
                reports. Great for automation or periodic audits.
              </p>
              <div className="product-tags">
                <span>Python 3.10+</span><span>Apple Mail</span>
              </div>
              <div className="product-code">pip install inboxpie</div>
              <a href="https://pypi.org/project/inboxpie" className="product-link" target="_blank" rel="noreferrer">View on PyPI →</a>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────── */}
      <section className="cta-section fade-up">
        <div className="container">
          <h2 className="cta-h2">Make your inbox make sense.</h2>
          <p className="cta-sub">
            Free. Open source. Runs entirely on your machine. No account required.
          </p>
          <div className="cta-actions">
            <a className="btn-primary" href="#apps">Get InboxPie</a>
            <a className="btn-ghost"
               href="https://github.com/inboxpie/inboxpie"
               target="_blank" rel="noreferrer">
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ───────────────────────────────────────────── */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand"><LogoMark /><span>InboxPie</span></div>
          <p className="footer-tag">Privacy-First Email Analytics &amp; Intelligence</p>
          <div className="footer-links">
            <a href="#features">Features</a>
            <a href="#smartsearch">SmartSearch</a>
            <a href="#privacy">Privacy</a>
            <a href="#apps">Apps</a>
            <a href="https://github.com/inboxpie/inboxpie" target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <p className="footer-copy">© {new Date().getFullYear()} InboxPie · Built privacy-first.</p>
        </div>
      </footer>
    </div>
  )
}
