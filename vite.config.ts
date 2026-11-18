import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: 'sidepanel.html' } },
  plugins: [{
    // Dev server only: lets the panel run beside the demo page in dev/index.html.
    name: 'chrome-stub',
    apply: 'serve',
    transformIndexHtml: (html, ctx) =>
      ctx.path === '/sidepanel.html' ? html.replace('<script type="module"', '<script src="/dev/chrome-stub.js"></script>\n<script type="module"') : html,
  }],
});
