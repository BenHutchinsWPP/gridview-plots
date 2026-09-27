// tests/test_fixtures_uplot.mjs — a stand-in for the `uplot` package, so the
// time, duration and stacked adapters (src/ui/panes/line.ts) run in Node.
// Importing this file routes every `import uPlot from 'uplot'` to the class
// below, which draws nothing and records the options and data each plot was
// built with. That is the adapter's whole contract with uPlot: what it asks
// for, not how uPlot paints it.
//
// Usage: import './test_loader.mjs'; import './test_fixtures_uplot.mjs';
// then import the adapters.

import { register } from 'node:module';

/** Every plot constructed since the last `plots.length = 0`, oldest first. */
export const plots = [];

export default class FakeUPlot {
  constructor(options, data, root) {
    this.options = options;
    this.series = options.series;
    this.bands = options.bands;
    this.data = data;
    this.root = root;
    this.scales = { x: { min: 0, max: (data[0]?.length ?? 1) - 1 } };
    this.bbox = { left: 0, top: 0, width: options.width, height: options.height };
    this.destroyed = false;
    plots.push(this);
  }
  setData(data) {
    this.data = data;
  }
  setScale(key, { min, max }) {
    this.scales[key] = { min, max };
  }
  setSize({ width, height }) {
    this.bbox = { ...this.bbox, width, height };
  }
  destroy() {
    this.destroyed = true;
  }
  posToVal(px) {
    return px;
  }
  valToPos(value) {
    return value;
  }
}

const self = import.meta.url;
const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'uplot') return { url: ${JSON.stringify(self)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);
