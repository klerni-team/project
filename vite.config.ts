import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {defineConfig, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import {astryxStylex} from '@astryxdesign/build/vite';

/**
 * Writes dist/sw.js from sw/sw.js with this build's files baked in. Runs
 * last, after every plugin has written its output (StyleX emits its CSS in
 * its own closeBundle).
 */
function serviceWorker(): Plugin {
  let dir = 'dist';
  return {
    name: 'habits-service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      dir = config.build.outDir;
    },
    closeBundle: {
      order: 'post',
      handler() {
        // Install-icon PNGs are only read by the OS at install time; .woff is
        // a fallback no supported browser needs next to .woff2.
        const skip = (f: string) =>
          f === '/index.html' || f === '/sw.js' || f.endsWith('.map') || f.endsWith('.woff') || /icon-(192|512)/.test(f);
        const files = readdirSync(dir, {recursive: true, withFileTypes: true})
          .filter(e => e.isFile())
          .map(e => '/' + relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
          .filter(f => !skip(f))
          .sort();
        // Hash contents, not names: an edited icon or manifest keeps its name.
        const hash = createHash('sha256');
        for (const f of ['/index.html', ...files]) hash.update(f).update(readFileSync(join(dir, f)));
        const version = hash.digest('hex').slice(0, 12);
        const source = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8')
          .replace("'habits-__VERSION__'", `'habits-${version}'`)
          .replace('= __PRECACHE__;', `= ${JSON.stringify(files)};`);
        writeFileSync(join(dir, 'sw.js'), source);
      },
    },
  };
}

export default defineConfig({
  plugins: [...astryxStylex(), react(), serviceWorker()],
  server: {
    host: true,
    proxy: {'/api': 'http://localhost:8787'},
  },
});
