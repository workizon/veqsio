import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    // Modules ship their own web code (community in modules/, Enterprise in ee/modules/).
    '../../modules/*/src/**/*.{ts,tsx}',
    '../../ee/modules/*/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#EEF3FF',
          100: '#DCE6FF',
          200: '#BCCFFF',
          300: '#8FAEFF',
          400: '#5F89FA',
          500: '#3D6AF0',
          600: '#2D54D8',
          700: '#2444B0',
          800: '#1E3A8A',
          900: '#172B66',
        },
        surface: {
          0: '#FFFFFF',
          1: '#F8F9FB',
          2: '#F1F3F7',
          3: '#E6E9EF',
          4: '#D6DAE3',
        },
        'text-primary': '#101828',
        'text-secondary': '#475467',
        'text-tertiary': '#8791A3',
        success: '#16A06A',
        warning: '#F79009',
        error: '#D92D20',
        info: '#2D54D8',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'Geist', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['var(--font-geist-mono)', '"Geist Mono"', '"JetBrains Mono"', '"SF Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        display: ['24px', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' }],
        'heading-1': ['20px', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'heading-2': ['16px', { lineHeight: '1.4', letterSpacing: '-0.011em', fontWeight: '600' }],
        'heading-3': ['14px', { lineHeight: '1.4', letterSpacing: '-0.006em', fontWeight: '600' }],
        body: ['14px', { lineHeight: '1.5' }],
        'body-sm': ['13px', { lineHeight: '1.5' }],
        caption: ['12px', { lineHeight: '1.4', letterSpacing: '0.01em', fontWeight: '500' }],
        'caption-sm': ['11px', { lineHeight: '1.3', letterSpacing: '0.02em', fontWeight: '500' }],
      },
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        '2xl': '32px',
        '3xl': '48px',
        '4xl': '64px',
        // `pt-header`, `lg:pl-sidebar` etc. resolve through `spacing`; width/height keys alone do not generate them.
        sidebar: '240px',
        'sidebar-collapsed': '64px',
        header: '56px',
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.06)',
        md: '0 2px 8px rgba(0,0,0,0.08)',
        lg: '0 4px 12px rgba(0,0,0,0.1)',
        xl: '0 20px 40px rgba(0,0,0,0.15)',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-out-smooth': 'cubic-bezier(0.65, 0, 0.35, 1)',
      },
      transitionDuration: {
        fast: '100ms',
        base: '150ms',
        slow: '250ms',
      },
      maxWidth: {
        'content': '1440px',
      },
      width: {
        'sidebar': '240px',
        'sidebar-collapsed': '64px',
      },
      height: {
        'header': '56px',
      },
    },
  },
  plugins: [],
}
export default config
