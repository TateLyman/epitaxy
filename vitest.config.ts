import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `node:sqlite` is exported by Node only under the `node:` prefix, so Vite's
  // builtin check — which strips the prefix before looking the name up — misses
  // it and tries to resolve a package called `sqlite`. The shim hands the module
  // back to Node's own loader at runtime instead of letting Vite resolve it.
  plugins: [
    {
      name: 'externalize-node-sqlite',
      enforce: 'pre',
      resolveId(id: string) {
        if (id === 'node:sqlite' || id === 'sqlite') return '\0node-sqlite-shim';
        return null;
      },
      load(id: string) {
        if (id !== '\0node-sqlite-shim') return null;
        return [
          "import { createRequire } from 'node:module';",
          'const mod = createRequire(import.meta.url)("node:sqlite");',
          'export const DatabaseSync = mod.DatabaseSync;',
          'export const StatementSync = mod.StatementSync;',
          'export default mod;',
        ].join('\n');
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests reach the network and are opt-in, so a failing
    // provider can never be mistaken for a failing build.
    exclude: ['node_modules/**', 'tests/integration/**'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    reporters: ['default'],
  },
});
