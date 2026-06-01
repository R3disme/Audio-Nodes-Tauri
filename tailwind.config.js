/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  theme: {
    extend: {
      colors: {
        canvas: '#1a1a1a',
        node: {
          bg: '#2d2d2d',
          border: '#404040',
          header: {
            input: '#1a5276',
            output: '#1d6a3a',
            volume: '#784212',
            eq: '#512e8e',
            compressor: '#117864',
            gate: '#6e2020',
            mixer: '#76448a',
          }
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace']
      }
    }
  },
  plugins: []
}
