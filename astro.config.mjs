import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.logorytm.com',

  integrations: [sitemap()],

  vite: {
    plugins: [tailwindcss()],
  },

  image: {
    service: {
      entrypoint: 'astro/assets/services/sharp'
    }
  }
});