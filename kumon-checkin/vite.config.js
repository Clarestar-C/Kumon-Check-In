import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps every asset path relative, so the built app works on
// GitHub Pages whether it is a user site or a project site.
export default defineConfig({
  base: './',
  plugins: [react()],
});
