/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          500: '#30BCED',
          600: '#2A9FCC',
          accent: '#5BB8F5',
        },
        secondary: {
          500: '#F5F5F5',
        },
        cyan: {
          light: '#97fff2',
          bright: '#7FD0FF',
        },
        teal: {
          dark: '#09616c',
        },
        gray: {
          text: '#374151',
          mid: '#576A84',
          light: '#6B7280',
          bg: '#F5F5F5',
          border: '#E1E1E1',
        },
        accent: {
          red: '#CB4E3C',
          green: '#65CE8E',
          blue: '#5598FF',
          gold: '#F5D399',
        },
      },
      fontFamily: {
        satoshi: ['Satoshi', 'sans-serif'],
        inter: ['Inter', 'sans-serif'],
      },
      fontSize: {
        xs: ['12px', { lineHeight: '16px', letterSpacing: '-0.02em' }],
        sm: ['14px', { lineHeight: '20px', letterSpacing: '-0.01em' }],
        base: ['16px', { lineHeight: '24px', letterSpacing: '-0.01em' }],
        lg: ['18px', { lineHeight: '28px', letterSpacing: '-0.01em' }],
        xl: ['20px', { lineHeight: '28px', letterSpacing: '-0.02em' }],
        '2xl': ['24px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        '3xl': ['32px', { lineHeight: '40px', letterSpacing: '-0.03em' }],
        '4xl': ['40px', { lineHeight: '48px', letterSpacing: '-0.03em' }],
      },
      spacing: {
        gutter: '3.5rem',
        section: '6rem',
      },
      borderRadius: {
        lg: '12px',
        xl: '16px',
        '2xl': '24px',
        full: '9999px',
      },
      boxShadow: {
        sm: '0px 1px 2px rgba(0, 0, 0, 0.05)',
        base: '0px 4px 12px rgba(0, 0, 0, 0.08)',
        md: '0px 8px 24px rgba(0, 0, 0, 0.12)',
        lg: '0px 12px 32px rgba(0, 0, 0, 0.15)',
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-out',
        'slide-up': 'slideUp 0.6s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
