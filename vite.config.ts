import { defineConfig, loadEnv } from 'vite';

// Two builds from one panel:
// - default: the Chrome extension (dist/, or release/ with --mode judges)
// - --mode web: try.html, the panel beside the demo pages for anyone to try without installing (web-dist/)
export default defineConfig(({ mode, command }) => {
  const web = mode === 'web';
  if (web && command === 'build' && !loadEnv(mode, '.', 'VITE_').VITE_RECAPTCHA_SITE_KEY) {
    throw new Error('The web build needs VITE_RECAPTCHA_SITE_KEY in .env.web.local');
  }
  return {
    base: './',
    publicDir: web ? false : 'public',
    // The public web build must never contain the App Check debug token. It uses reCAPTCHA instead.
    define: web && command === 'build' ? { 'import.meta.env.VITE_APPCHECK_DEBUG_TOKEN': '""' } : {},
    build: {
      outDir: web ? 'web-dist' : 'dist',
      emptyOutDir: true,
      rollupOptions: { input: web ? ['try.html', 'sidepanel.html'] : 'sidepanel.html' },
    },
    plugins: [{
      // In the web version the panel starts from src/web.ts, which stands in for chrome.* first.
      name: 'web-panel',
      transformIndexHtml: {
        order: 'pre',
        handler: (html: string, ctx: { filename: string }) =>
          web && ctx.filename.endsWith('sidepanel.html') ? html.replace('./src/main.ts', './src/web.ts') : html,
      },
    }],
  };
});
