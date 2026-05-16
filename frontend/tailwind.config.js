/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        playfair: ['"Playfair Display"', 'serif'],
        inter: ['Inter', 'sans-serif'],
      },
      colors: {
        // Dark mode tokens
        dark: {
          bg: '#000000',
          card: '#0D0D0D',
          cardHover: '#141414',
          cardActive: '#161616',
        },
        // Light mode tokens
        light: {
          bg: '#FAF6EE',
          card: '#F2EBD9',
          cardHover: '#EDE4CF',
          cardActive: '#E8DFC8',
        },
        // Gold accent system
        gold: {
          DEFAULT: '#D4AF37',
          dark: '#B8960C',
          dim: 'rgba(212,175,55,0.15)',
          border: 'rgba(212,175,55,0.08)',
          borderActive: 'rgba(212,175,55,0.4)',
          borderHover: 'rgba(212,175,55,0.2)',
        },
        // Subject colours — dark mode
        economics: {
          bg: '#0A1929',
          text: '#7EB8E8',
        },
        business: {
          bg: '#0A1F12',
          text: '#6DBF8A',
        },
        english: {
          bg: '#1F1208',
          text: '#E8A86D',
        },
        ict: {
          bg: '#120A1F',
          text: '#A87EE8',
        },
        // Subject colours — light mode
        economicsLight: {
          bg: '#EBF4FC',
          text: '#1B5E8A',
        },
        businessLight: {
          bg: '#EBF7EF',
          text: '#1B5E3A',
        },
        englishLight: {
          bg: '#FBF3EB',
          text: '#7A3E10',
        },
        ictLight: {
          bg: '#F3EBFB',
          text: '#4E1B8A',
        },
      },
      borderRadius: {
        card: '10px',
        button: '8px',
        badge: '3px',
        chat: '12px',
      },
      fontSize: {
        'label': ['10px', { letterSpacing: '0.1em' }],
        'badge': ['10px', { letterSpacing: '0.05em' }],
      },
      animation: {
        'pull-up': 'pullUp 0.7s cubic-bezier(0.16,1,0.3,1) forwards',
        'fade-in': 'fadeIn 0.6s ease forwards',
        'stagger-in': 'staggerIn 0.6s cubic-bezier(0.22,1,0.36,1) forwards',
      },
      keyframes: {
        pullUp: {
          'from': { transform: 'translateY(24px)', opacity: '0' },
          'to': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          'from': { opacity: '0' },
          'to': { opacity: '1' },
        },
        staggerIn: {
          'from': { transform: 'scale(0.97) translateY(10px)', opacity: '0' },
          'to': { transform: 'scale(1) translateY(0)', opacity: '1' },
        },
      },
      backdropBlur: {
        nav: '12px',
      },
    },
  },
  plugins: [],
}
