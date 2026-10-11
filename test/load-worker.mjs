import { build } from 'esbuild';

/** Bundle the Worker with @sentry/cloudflare stubbed so tests stay SDK-free. */
export async function loadWorker() {
  const compiled = await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    plugins: [{
      name: 'sentry-stub',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@sentry\/cloudflare$/ }, () => ({
          path: 'sentry-stub',
          namespace: 'sentry-stub',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'sentry-stub' }, () => ({
          contents: [
            'export function withSentry(_optionsCallback, handler) { return handler; }',
            'export const logger = { trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} };',
            'export function consoleLoggingIntegration() { return { name: "ConsoleLogs" }; }',
          ].join('\n'),
          loader: 'js',
        }));
      },
    }],
  });
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
}
