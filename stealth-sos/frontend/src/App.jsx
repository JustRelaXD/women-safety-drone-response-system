/**
 * App.jsx
 * Root component for Stealth SOS – Guardian Drone Response System.
 * Orchestrates all sections: loading screen, hero, map, status panel,
 * timeline, stats, and emergency controls.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence, useScroll, useTransform, useInView } from 'framer-motion'
import {
  RiShieldCheckLine,
  RiMapPin2Line,
  RiWifiLine,
  RiLoader4Line,
  RiRadarLine,
  RiAlertLine,
  RiCheckDoubleLine,
  RiFlightTakeoffLine,
  RiTimeLine,
  RiGlobalLine,
  RiArrowRightLine,
} from 'react-icons/ri'

import SOSDetector    from './components/SOSDetector'
import MapView        from './components/MapView'
import ConfirmationPanel from './components/ConfirmationPanel'
import { useSocket }  from './hooks/useSocket'

// ─── Animated counter ─────────────────────────────────────────────────
function Counter({ to, suffix = '', duration = 2 }) {
  const ref    = useRef(null)
  const inView = useInView(ref, { once: true })
  const [val, setVal] = useState(0)

  useEffect(() => {
    if (!inView) return
    let start  = 0
    const step = to / (duration * 60)
    const id   = setInterval(() => {
      start += step
      if (start >= to) { setVal(to); clearInterval(id) }
      else setVal(Math.floor(start))
    }, 1000 / 60)
    return () => clearInterval(id)
  }, [inView, to, duration])

  return (
    <span ref={ref} className="stat-glow tabular-nums">
      {val.toLocaleString()}{suffix}
    </span>
  )
}

// ─── Loading Screen ────────────────────────────────────────────────────
function LoadingScreen({ onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2800)
    return () => clearTimeout(t)
  }, [])

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 1, ease: 'easeInOut' } }}
      className="fixed inset-0 z-50 bg-void flex flex-col items-center justify-center"
    >
      {/* Animated rings */}
      <div className="relative w-32 h-32 mb-10">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="absolute inset-0 rounded-full border border-blue-500/30"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1.8 + i * 0.6, opacity: 0 }}
            transition={{ duration: 2.4, delay: i * 0.6, repeat: Infinity, ease: 'easeOut' }}
          />
        ))}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/40
                          flex items-center justify-center">
            <RiShieldCheckLine className="text-blue-400 text-3xl" />
          </div>
        </div>
      </div>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="text-white text-sm tracking-[0.3em] uppercase font-light"
      >
        GUARDIAN SYSTEM
      </motion.p>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="text-muted text-xs tracking-widest mt-2 uppercase"
      >
        Initialising secure network
      </motion.p>

      <motion.div
        className="mt-10 w-48 h-px bg-subtle overflow-hidden rounded"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
      >
        <motion.div
          className="h-full bg-gradient-to-r from-transparent via-blue-400 to-transparent"
          initial={{ x: '-100%' }}
          animate={{ x: '200%' }}
          transition={{ duration: 1.4, delay: 1.1, ease: 'easeInOut' }}
        />
      </motion.div>
    </motion.div>
  )
}

// ─── Hero Section ─────────────────────────────────────────────────────
function Hero({ sosActive, onManualSOS }) {
  const { scrollY } = useScroll()
  const y           = useTransform(scrollY, [0, 400], [0, -80])
  const opacity     = useTransform(scrollY, [0, 300], [1, 0])

  return (
    <motion.section
      style={{ y, opacity }}
      className="relative min-h-screen flex flex-col justify-center items-center
                 px-6 text-center overflow-hidden"
    >
      {/* Background grid */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage:
              'linear-gradient(#ffffff 1px,transparent 1px),linear-gradient(90deg,#ffffff 1px,transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />
        {/* Radial glow */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(59,130,246,0.08) 0%, transparent 70%)',
          }}
        />
      </div>

      {/* Eyebrow */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.8 }}
        className="flex items-center gap-2 mb-8"
      >
        <span className="w-6 h-px bg-blue-500/60" />
        <span className="text-blue-400 text-xs tracking-[0.25em] uppercase font-medium">
          Silent Emergency Response
        </span>
        <span className="w-6 h-px bg-blue-500/60" />
      </motion.div>

      {/* Headline */}
      <motion.h1
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.9, ease: [0.16,1,0.3,1] }}
        className="text-5xl md:text-7xl lg:text-8xl font-bold leading-[0.95] tracking-tight
                   text-white max-w-4xl"
      >
        Guardian
        <br />
        <span className="text-transparent bg-clip-text bg-gradient-to-r
                         from-blue-400 via-blue-300 to-blue-500">
          arrives first.
        </span>
      </motion.h1>

      {/* Sub */}
      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.8 }}
        className="mt-8 text-muted text-base md:text-lg max-w-lg leading-relaxed font-light"
      >
        One silent gesture deploys a guardian drone to your exact location.
        No alerts. No noise. No trace.
      </motion.p>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.65, duration: 0.8 }}
        className="mt-12 flex flex-col sm:flex-row gap-4 items-center"
      >
        <motion.button
          whileHover={{ scale: 1.03, boxShadow: '0 0 40px rgba(59,130,246,0.3)' }}
          whileTap={{ scale: 0.97 }}
          onClick={onManualSOS}
          className="px-8 py-4 rounded-full bg-blue-600 hover:bg-blue-500
                     text-white text-sm font-semibold tracking-wide
                     transition-colors duration-300 flex items-center gap-2"
        >
          <RiRadarLine className="text-lg" />
          Trigger Demo SOS
          <RiArrowRightLine />
        </motion.button>

        <p className="text-muted text-xs">
          or press <kbd className="px-2 py-0.5 rounded bg-subtle border border-white/10
                                   text-white/60 font-mono text-xs">S</kbd> on your keyboard
        </p>
      </motion.div>

      {/* Active indicator */}
      <AnimatePresence>
        {sosActive && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-10 flex items-center gap-3 px-5 py-3 rounded-full
                       glass border border-blue-500/30"
          >
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse-slow" />
            <span className="text-blue-300 text-sm font-medium">
              Guardian arriving. Stay calm.
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Scroll hint */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2 }}
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col
                   items-center gap-2 text-muted/40"
      >
        <motion.div
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-px h-8 bg-gradient-to-b from-transparent via-muted/30 to-transparent"
        />
      </motion.div>
    </motion.section>
  )
}

// ─── Drone Status Panel ───────────────────────────────────────────────
function DroneStatusPanel({ droneInfo, dronePos, sosActive }) {
  if (!sosActive && !dronePos) return null

  const progress = dronePos?.progress ?? 0

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="glass rounded-2xl p-5 w-full"
    >
      <div className="flex items-center gap-2 mb-4">
        <RiFlightTakeoffLine className="text-blue-400 text-lg" />
        <p className="text-white text-sm font-semibold">
          {droneInfo?.drone_name ?? 'Guardian Alpha'}
        </p>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full
                         bg-blue-500/20 border border-blue-500/30 text-blue-300">
          {droneInfo?.drone_id ?? 'DR-001'}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-subtle rounded-full overflow-hidden mb-3">
        <motion.div
          className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full"
          initial={{ width: '0%' }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        <span>Deployed</span>
        <span className="text-blue-400 font-medium tabular-nums">
          {Math.round(progress)}%
        </span>
        <span>On-site</span>
      </div>

      {droneInfo && (
        <div className="mt-4 pt-4 border-t border-white/5 flex gap-4 text-xs">
          <div>
            <p className="text-muted">ETA</p>
            <p className="text-white font-medium mt-0.5">
              {droneInfo.estimated_arrival_seconds}s
            </p>
          </div>
          <div>
            <p className="text-muted">Signal</p>
            <p className="text-emerald-400 font-medium mt-0.5 flex items-center gap-1">
              <RiWifiLine /> Strong
            </p>
          </div>
          <div>
            <p className="text-muted">Mode</p>
            <p className="text-white font-medium mt-0.5">Stealth</p>
          </div>
        </div>
      )}
    </motion.div>
  )
}

// ─── Timeline ─────────────────────────────────────────────────────────
function Timeline({ sosActive, dronePos, droneArrived }) {
  const progress = dronePos?.progress ?? 0
  const steps = [
    {
      id: 0,
      label: 'SOS Triggered',
      sub:   'Silent activation detected',
      icon:  RiAlertLine,
      done:  sosActive,
    },
    {
      id: 1,
      label: 'Drone Dispatched',
      sub:   'Nearest unit deployed',
      icon:  RiFlightTakeoffLine,
      done:  progress > 5,
    },
    {
      id: 2,
      label: 'En Route',
      sub:   `${Math.round(progress)}% of journey complete`,
      icon:  RiRadarLine,
      done:  progress > 10,
      active: progress > 5 && progress < 98,
    },
    {
      id: 3,
      label: 'Guardian Arrived',
      sub:   'Emergency controls unlocked',
      icon:  RiCheckDoubleLine,
      done:  droneArrived,
    },
  ]

  return (
    <div className="glass rounded-2xl p-6 w-full">
      <p className="text-white text-sm font-semibold mb-5 flex items-center gap-2">
        <RiTimeLine className="text-blue-400" /> Response Timeline
      </p>

      <div className="space-y-0">
        {steps.map((step, i) => {
          const Icon = step.icon
          const isLast = i === steps.length - 1
          return (
            <div key={step.id} className="relative flex gap-4">
              {/* Vertical line */}
              {!isLast && (
                <div className="absolute left-[11px] top-7 bottom-0 w-px bg-white/5">
                  {step.done && (
                    <motion.div
                      className="w-full bg-blue-500/40"
                      initial={{ height: '0%' }}
                      animate={{ height: '100%' }}
                      transition={{ duration: 0.6 }}
                    />
                  )}
                </div>
              )}

              {/* Dot */}
              <div className={`
                relative z-10 w-6 h-6 rounded-full border-2 flex-shrink-0
                flex items-center justify-center mt-0.5
                transition-all duration-500
                ${step.done
                  ? 'border-blue-400 bg-blue-500/20'
                  : step.active
                    ? 'border-blue-500/60 bg-blue-500/10 animate-pulse-slow'
                    : 'border-white/10 bg-white/5'}
              `}>
                {step.done
                  ? <Icon className="text-blue-400 text-xs" />
                  : <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
                }
              </div>

              {/* Text */}
              <div className="pb-6">
                <p className={`text-sm font-medium transition-colors duration-500
                  ${step.done ? 'text-white' : 'text-muted'}`}>
                  {step.label}
                </p>
                <p className="text-xs text-muted/60 mt-0.5">{step.sub}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Stats Section ────────────────────────────────────────────────────
function StatsSection() {
  const ref    = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })

  const stats = [
    { value: 47,    suffix: 's',  label: 'Average response time' },
    { value: 3200,  suffix: '+',  label: 'Drones deployed globally' },
    { value: 99,    suffix: '.8%',label: 'Uptime guarantee' },
    { value: 180,   suffix: '+',  label: 'Cities covered' },
  ]

  return (
    <section ref={ref} className="py-32 px-6 md:px-12">
      <div className="max-w-6xl mx-auto">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7 }}
          className="mb-16 text-center"
        >
          <p className="text-blue-400 text-xs tracking-[0.25em] uppercase mb-4">
            By the numbers
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-white tracking-tight">
            Precision at scale.
          </h2>
        </motion.div>

        {/* Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-white/5 rounded-2xl overflow-hidden">
          {stats.map((s, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: i * 0.1, duration: 0.6 }}
              className="bg-obsidian p-8 md:p-10 flex flex-col"
            >
              <p className="text-3xl md:text-5xl font-bold text-white mb-3 leading-none">
                {inView ? <Counter to={s.value} suffix={s.suffix} /> : '0'}
              </p>
              <p className="text-muted text-xs md:text-sm leading-relaxed">{s.label}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Features row ─────────────────────────────────────────────────────
function FeaturesSection() {
  const ref    = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })

  const features = [
    {
      icon:  RiRadarLine,
      title: 'Invisible trigger',
      body:  'A phone shake or a single keypress. No app open, no bright screen, no sound.',
    },
    {
      icon:  RiMapPin2Line,
      title: 'Precision routing',
      body:  'GPS-locked path planning dispatches the nearest drone within milliseconds.',
    },
    {
      icon:  RiShieldCheckLine,
      title: 'Full autonomy',
      body:  'On arrival the drone activates siren, strobe, live recording, and authorities.',
    },
    {
      icon:  RiGlobalLine,
      title: 'Global coverage',
      body:  'Fleet nodes across 180+ cities, connected through an encrypted mesh network.',
    },
  ]

  return (
    <section ref={ref} className="py-24 px-6 md:px-12 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((f, i) => {
            const Icon = f.icon
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 24 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: i * 0.1, duration: 0.6 }}
                whileHover={{ y: -4, transition: { duration: 0.3 } }}
                className="glass rounded-2xl p-6 group cursor-default"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20
                                flex items-center justify-center mb-5
                                group-hover:bg-blue-500/20 group-hover:border-blue-500/40
                                transition-all duration-300">
                  <Icon className="text-blue-400 text-xl" />
                </div>
                <p className="text-white text-sm font-semibold mb-2">{f.title}</p>
                <p className="text-muted text-xs leading-relaxed">{f.body}</p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── Map Section ──────────────────────────────────────────────────────
function MapSection({ userPos, dronePos, droneArrived, droneInfo, sosActive, droneArrivalMsg }) {
  const ref    = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })

  return (
    <section
      ref={ref}
      id="map"
      className="py-16 px-6 md:px-12 border-t border-white/5"
    >
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-8"
        >
          <p className="text-blue-400 text-xs tracking-[0.25em] uppercase mb-3">
            Live operations
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
            Guardian Network
          </h2>
        </motion.div>

        <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
          {/* Map */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={inView ? { opacity: 1 } : {}}
            transition={{ delay: 0.2 }}
            className="glass rounded-2xl overflow-hidden"
            style={{ height: 480 }}
          >
            <MapView
              userPos={userPos}
              dronePos={dronePos}
              droneArrived={droneArrived}
            />
          </motion.div>

          {/* Side panels */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.3 }}
            className="flex flex-col gap-4"
          >
            {/* Arrival message */}
            <AnimatePresence>
              {droneArrivalMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl
                             bg-blue-500/10 border border-blue-500/30"
                >
                  <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse-slow flex-shrink-0" />
                  <p className="text-blue-300 text-xs font-medium">
                    Guardian arriving. Stay calm.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            <DroneStatusPanel
              droneInfo={droneInfo}
              dronePos={dronePos}
              sosActive={sosActive}
            />

            <Timeline
              sosActive={sosActive}
              dronePos={dronePos}
              droneArrived={droneArrived}
            />

            <ConfirmationPanel visible={droneArrived} />
          </motion.div>
        </div>
      </div>
    </section>
  )
}

// ─── Footer ───────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="py-12 px-6 border-t border-white/5 text-center">
      <p className="text-muted/40 text-xs tracking-widest uppercase">
        Stealth SOS · Guardian Drone Response System
      </p>
      <p className="text-muted/30 text-xs mt-2">
        Press <span className="text-white/30">S</span> or shake to activate
      </p>
    </footer>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────
export default function App() {
  const [loaded,          setLoaded]          = useState(false)
  const [sosActive,       setSosActive]       = useState(false)
  const [userPos,         setUserPos]         = useState(null)
  const [droneInfo,       setDroneInfo]       = useState(null)
  const [droneArrivalMsg, setDroneArrivalMsg] = useState(false)

  const { dronePos, droneArrived, resetDrone } = useSocket()

  // Show arrival message when drone starts moving
  useEffect(() => {
    if (dronePos && !droneArrivalMsg) setDroneArrivalMsg(true)
  }, [dronePos])

  // ── SOS handler ──────────────────────────────────────────────────
  const handleSOS = useCallback(async ({ lat, lng }) => {
    if (sosActive) return
    setSosActive(true)
    setUserPos({ lat, lng })

    try {
      const res = await fetch('/stealth-sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lng }),
      })
      const data = await res.json()
      setDroneInfo(data)
    } catch (err) {
      console.error('[SOS] Backend unreachable:', err)
      // Still show UI in demo mode even if backend is down
    }

    // Scroll to map
    setTimeout(() => {
      document.getElementById('map')?.scrollIntoView({ behavior: 'smooth' })
    }, 400)
  }, [sosActive])

  const handleManualSOS = () => {
    const lat = 51.5074 + (Math.random() - 0.5) * 0.02
    const lng = -0.1278 + (Math.random() - 0.5) * 0.02
    handleSOS({ lat, lng })
  }

  return (
    <div className="noise bg-void min-h-screen text-white">
      {/* Loading */}
      <AnimatePresence>
        {!loaded && <LoadingScreen onDone={() => setLoaded(true)} />}
      </AnimatePresence>

      {/* Silent SOS detector */}
      <SOSDetector active={loaded} onSOS={handleSOS} />

      {/* Content */}
      <AnimatePresence>
        {loaded && (
          <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
          >
            {/* Nav */}
            <nav className="fixed top-0 inset-x-0 z-40 flex items-center justify-between
                            px-6 md:px-12 py-5">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
                className="flex items-center gap-2"
              >
                <RiShieldCheckLine className="text-blue-400 text-xl" />
                <span className="text-white text-sm font-semibold tracking-wide">
                  STEALTH SOS
                </span>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
                className="flex items-center gap-2"
              >
                {sosActive
                  ? <div className="flex items-center gap-2 text-xs text-blue-300">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                      Active
                    </div>
                  : <div className="flex items-center gap-2 text-xs text-muted">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted/40" />
                      Standby
                    </div>
                }
              </motion.div>
            </nav>

            {/* Sections */}
            <Hero sosActive={sosActive} onManualSOS={handleManualSOS} />
            <FeaturesSection />
            <MapSection
              userPos={userPos}
              dronePos={dronePos}
              droneArrived={droneArrived}
              droneInfo={droneInfo}
              sosActive={sosActive}
              droneArrivalMsg={droneArrivalMsg}
            />
            <StatsSection />
            <Footer />
          </motion.main>
        )}
      </AnimatePresence>
    </div>
  )
}
