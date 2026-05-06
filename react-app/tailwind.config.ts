import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'brand-primary': 'var(--color-primary)',
        'brand-secondary': 'var(--color-secondary)',
        'navy': 'var(--navy)',
        'navy-2': 'var(--navy-2)',
        'navy-3': 'var(--navy-3)',
        'amber': 'var(--amber)',
        'slate': 'var(--slate)',
        'gray': 'var(--gray)',
        'white': 'var(--white)',
        'teal': 'var(--teal)',
        'green': 'var(--green)',
      },
      spacing: {
        'sp-1': 'var(--sp-1)',
        'sp-2': 'var(--sp-2)',
        'sp-3': 'var(--sp-3)',
        'sp-4': 'var(--sp-4)',
        'sp-5': 'var(--sp-5)',
        'sp-6': 'var(--sp-6)',
        'sp-7': 'var(--sp-7)',
        'sp-8': 'var(--sp-8)',
        'sp-10': 'var(--sp-10)',
        'sp-12': 'var(--sp-12)',
        'sp-14': 'var(--sp-14)',
        'sp-16': 'var(--sp-16)',
        'sp-20': 'var(--sp-20)',
        'sp-24': 'var(--sp-24)',
      },
      borderRadius: {
        'radius-sm': 'var(--radius-sm)',
        'radius-md': 'var(--radius-md)',
        'radius-lg': 'var(--radius-lg)',
        'radius-full': 'var(--radius-full)',
      },
    },
  },
  plugins: [],
}
export default config
