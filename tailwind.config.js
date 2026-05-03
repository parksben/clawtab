/** @type {import('tailwindcss').Config} */
export default {
  content: ['./sidebar/index.html', './src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Match the palette used across the existing CSS so we can migrate
        // component-by-component without visual drift.
        brand: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
          soft: '#e0e7ff',
          ring: '#a5b4fc',
        },
        slate: {
          // tailwind ships these, listed here only as a reminder of which
          // shades we rely on: 50 (surface), 100 (hover), 200 (border),
          // 400 (muted icon), 500 (disabled), 600 (body), 900 (heading).
        },
      },
      fontFamily: {
        // Keep the system stack the sidepanel has always used.
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
      },
      keyframes: {
        'thinking-dot': {
          '0%, 80%, 100%': { transform: 'scale(0.7)', opacity: '0.4' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        'thinking-dot': 'thinking-dot 1.2s infinite ease-in-out both',
      },
    },
  },
  plugins: [],
};
