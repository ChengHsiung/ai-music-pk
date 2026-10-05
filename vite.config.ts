import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  // Everything (code, styles, notation fonts) is inlined into one index.html,
  // so the same file works on GitHub Pages and offline when opened from disk.
  plugins: [viteSingleFile()],
  base: './',
  test: {
    environment: 'node',
  },
});
