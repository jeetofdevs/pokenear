// Browser stand-ins for Node globals some NEAR wallet dependencies expect. Injected by esbuild.
import { Buffer } from 'buffer';
export { Buffer };
export const process = {
  env: { NODE_ENV: 'production' },
  browser: true,
  version: '',
  versions: {},
  platform: 'browser',
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args))
};
