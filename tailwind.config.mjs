import defaultTheme from 'tailwindcss/defaultTheme';

/** @type {import('tailwindcss').Config} */
export default {
    content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
    theme: {
        extend: {
            colors: {
                logorytm: {
                    dark: '#183848',
                    teal: '#569DAF',
                    green: '#88A68F',
                    accent: '#B3985F',
                    light: '#F5F9FC',
                    beige: '#FCFAF5',
                },
            },
            fontFamily: {
                sans: ['Inter', ...defaultTheme.fontFamily.sans],
                heading: ['Poppins', ...defaultTheme.fontFamily.sans],
            },
        },
    },
    plugins: [],
}