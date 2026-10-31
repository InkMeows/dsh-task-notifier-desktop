// Plain JS config so tsdown does NOT need the `unrun` TS-config loader
// (which only supports Node 22.13+/24). Mirrors the Web twin's config with the
// isolated Desktop package id, so the emitted `window.__ModuleLoader__.load`
// banner matches the name the desktop profile installs.
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = '@dsh-external/dsh-task-notifier-desktop'

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime',
  'cordis',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle]