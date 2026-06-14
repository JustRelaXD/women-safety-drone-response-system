/**
 * ConfirmationPanel.jsx
 * Displayed after the drone arrives. Provides emergency action buttons.
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RiAlarmWarningLine,
  RiFlashlightLine,
  RiVideoLine,
  RiPhoneLine,
  RiCheckLine,
  RiShieldCheckLine,
} from 'react-icons/ri'

const actions = [
  {
    id: 'siren',
    label: 'Activate Siren',
    icon: RiAlarmWarningLine,
    color: 'from-red-600/20 to-red-900/10 border-red-500/30 hover:border-red-400/60',
    glow: 'shadow-red-500/20',
    activeColor: 'from-red-600/40 to-red-800/20 border-red-400',
  },
  {
    id: 'strobe',
    label: 'Activate Strobe',
    icon: RiFlashlightLine,
    color: 'from-yellow-600/20 to-yellow-900/10 border-yellow-500/30 hover:border-yellow-400/60',
    glow: 'shadow-yellow-500/20',
    activeColor: 'from-yellow-500/40 to-yellow-700/20 border-yellow-400',
  },
  {
    id: 'record',
    label: 'Start Recording',
    icon: RiVideoLine,
    color: 'from-blue-600/20 to-blue-900/10 border-blue-500/30 hover:border-blue-400/60',
    glow: 'shadow-blue-500/20',
    activeColor: 'from-blue-500/40 to-blue-700/20 border-blue-400',
  },
  {
    id: 'authorities',
    label: 'Contact Authorities',
    icon: RiPhoneLine,
    color: 'from-emerald-600/20 to-emerald-900/10 border-emerald-500/30 hover:border-emerald-400/60',
    glow: 'shadow-emerald-500/20',
    activeColor: 'from-emerald-500/40 to-emerald-700/20 border-emerald-400',
  },
]

// ── Animation variants ────────────────────────────────────────────────
const panelVar = {
  hidden: { opacity: 0, y: 40, scale: 0.96 },
  show:   { opacity: 1, y: 0,  scale: 1, transition: { duration: 0.6, ease: [0.16,1,0.3,1] } },
}

const itemVar = {
  hidden: { opacity: 0, x: -16 },
  show:   (i) => ({
    opacity: 1,
    x: 0,
    transition: { delay: 0.2 + i * 0.08, duration: 0.5, ease: 'easeOut' },
  }),
}

export default function ConfirmationPanel({ visible }) {
  const [active, setActive] = useState({})

  const toggle = (id) =>
    setActive((prev) => ({ ...prev, [id]: !prev[id] }))

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          variants={panelVar}
          initial="hidden"
          animate="show"
          exit="hidden"
          className="glass rounded-2xl p-6 w-full"
        >
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-blue-500/20 border border-blue-500/40
                            flex items-center justify-center">
              <RiShieldCheckLine className="text-blue-400 text-xl" />
            </div>
            <div>
              <p className="text-white font-semibold text-sm tracking-wide">
                Guardian has arrived
              </p>
              <p className="text-muted text-xs mt-0.5">
                Stay calm. Emergency controls are active.
              </p>
            </div>
          </div>

          {/* Status badge */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="h-px bg-gradient-to-r from-blue-500/60 via-blue-400/30 to-transparent mb-6"
          />

          {/* Action buttons */}
          <div className="grid grid-cols-1 gap-3">
            {actions.map((act, i) => {
              const Icon = act.icon
              const on   = active[act.id]
              return (
                <motion.button
                  key={act.id}
                  custom={i}
                  variants={itemVar}
                  initial="hidden"
                  animate="show"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => toggle(act.id)}
                  className={`
                    relative flex items-center gap-4 px-5 py-4 rounded-xl
                    bg-gradient-to-r border transition-all duration-300
                    ${on ? act.activeColor : act.color}
                    shadow-lg ${act.glow}
                  `}
                >
                  <div className={`
                    w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0
                    bg-white/5 border border-white/10
                  `}>
                    <Icon className="text-white text-lg" />
                  </div>
                  <span className="text-white text-sm font-medium">{act.label}</span>

                  {on && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="ml-auto w-6 h-6 rounded-full bg-white/10
                                 flex items-center justify-center"
                    >
                      <RiCheckLine className="text-white text-xs" />
                    </motion.div>
                  )}

                  {/* Active shimmer */}
                  {on && (
                    <motion.div
                      initial={{ x: '-100%' }}
                      animate={{ x: '200%' }}
                      transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 1 }}
                      className="absolute inset-0 bg-gradient-to-r from-transparent
                                 via-white/5 to-transparent rounded-xl pointer-events-none"
                    />
                  )}
                </motion.button>
              )
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
