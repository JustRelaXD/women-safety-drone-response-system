/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        void:    '#080A0E',
        obsidian:'#0D1117',
        slate:   '#141920',
        muted:   '#8B929E',
        subtle:  '#1E2530',
        accent:  '#3B82F6',
        'accent-dim': '#1D4ED8',
        ghost:   'rgba(255,255,255,0.04)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
        'ping-slow':  'ping  2s cubic-bezier(0,0,0.2,1) infinite',
      },
    },
  },
  plugins: [],
}
