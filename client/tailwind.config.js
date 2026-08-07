/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/meeting/**/*.{js,jsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        surface: '#090d16',
        panel: '#0f172a',
        tile: '#131c30',
        accent: '#4f8cff',
        'accent-hover': '#3b76e6',
      },
    },
  },
  plugins: [],
};
