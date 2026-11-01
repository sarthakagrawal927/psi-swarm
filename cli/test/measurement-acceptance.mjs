import { register } from 'tsx/esm/api';

register();
await import('./lighthouse-module-attribution.test.ts');
await import('./measurement-series.test.ts');
await import('./measurement-api.test.ts');
