// tests/test_fixtures_dom.mjs — a deliberately small fake DOM for running a
// chart pane, its adapters and the shell's chrome in Node: elements with
// children, class and id selectors, attributes, listeners, a measured box,
// and a canvas context that records what it was asked to fill. It proves
// routing and arithmetic; layout is checked in the real app.

/** One recorded 2D context call. */
export function contextStub() {
  const calls = [];
  const noop = () => {};
  return {
    calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    setTransform: noop,
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    rotate: noop,
    clearRect: noop,
    rect: noop,
    clip: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    stroke: noop,
    fill: noop,
    fillRect(x, y, w, h) {
      calls.push({ op: 'fillRect', x, y, w, h, fill: this.fillStyle });
    },
    strokeRect(x, y, w, h) {
      calls.push({ op: 'strokeRect', x, y, w, h });
    },
    fillText(text, x, y) {
      calls.push({ op: 'fillText', text: String(text), x, y });
    },
    measureText: (text) => ({ width: String(text).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
  };
}

/** `element.style`: plain properties, plus the custom-property calls. */
class FakeStyle {
  setProperty(name, value) {
    this[name] = value;
  }
  removeProperty(name) {
    delete this[name];
  }
}

/** `element.classList`, read and written through `className`. */
class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  get names() {
    return this.element.className.split(/\s+/).filter(Boolean);
  }
  contains(name) {
    return this.names.includes(name);
  }
  add(name) {
    if (!this.contains(name)) this.element.className = [...this.names, name].join(' ');
  }
  remove(name) {
    this.element.className = this.names.filter((n) => n !== name).join(' ');
  }
  toggle(name, force) {
    const on = force ?? !this.contains(name);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

export class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this.attributes = {};
    this.id = '';
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.width = 0;
    this.height = 0;
    this.rect = { width: 400, height: 300 };
    this.listeners = {};
    this.context = contextStub();
  }
  get clientWidth() {
    return this.rect.width;
  }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, before) {
    child.remove();
    const at = before ? this.children.indexOf(before) : -1;
    child.parentElement = this;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  contains(node) {
    for (let at = node; at; at = at.parentElement) if (at === this) return true;
    return false;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  setPointerCapture() {}
  /** Strings become text nodes, as in the DOM. */
  append(...children) {
    for (const child of children) {
      if (typeof child !== 'string') this.appendChild(child);
      else this.appendChild(new FakeElement('#text')).textContent = child;
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type, listener) {
    const list = this.listeners[type] ?? [];
    if (list.includes(listener)) list.splice(list.indexOf(listener), 1);
  }
  /** Fire `type` at this element's listeners. */
  fire(type, event = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  getBoundingClientRect() {
    return this.rect;
  }
  getContext() {
    return this.context;
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  /** One class (`.a`) or id (`#a`), which is all the panes and chrome query. */
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1));
  }
  querySelector(selector) {
    return this.descendants().find((node) => node.matches(selector)) ?? null;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((node) => node.matches(selector));
  }
}

/** Install the fake as the global document and window. `document` and
 * `window` take listeners and `fire` them, like an element. */
export function installFakeDom() {
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = 1;
  const listeners = (target) => {
    const on = new FakeElement();
    target.addEventListener = on.addEventListener.bind(on);
    target.removeEventListener = on.removeEventListener.bind(on);
    target.fire = on.fire.bind(on);
    target.listeners = on.listeners;
  };
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    body: new FakeElement('body'),
  };
  listeners(globalThis.document);
  listeners(globalThis);
  globalThis.getComputedStyle = () => ({ gridTemplateRows: '' });
}

/** A control inside its own label, as every pane header lays them out. */
function labelled(control) {
  new FakeElement('label').appendChild(control);
  return control;
}

/** A pane header's elements, as the host resolves them. */
export function paneElements() {
  const select = (value) => {
    const element = labelled(new FakeElement('select'));
    element.value = value;
    element.options = [];
    return element;
  };
  const check = (checked = false) => {
    const element = labelled(new FakeElement('input'));
    element.checked = checked;
    return element;
  };
  const boxDim = select('case');
  boxDim.selectedOptions = [{ textContent: 'case' }];
  return {
    body: new FakeElement(),
    note: new FakeElement('span'),
    zoomReset: new FakeElement('button'),
    download: new FakeElement('button'),
    limits: check(true),
    follow: check(true),
    overview: check(false),
    overviewHost: new FakeElement(),
    boxDim,
    boxValues: check(false),
    xySwap: new FakeElement('button'),
    xyFit: check(false),
    intervalBy: select('day'),
    intervalColour: select('time'),
    intervalMean: check(true),
    intervalBand: check(false),
  };
}

/** A `PaneHost` for one adapter, recording its banners, notes and
 * re-render requests. */
export function stubHost({ size = { width: 400, height: 300 } } = {}) {
  const controls = paneElements();
  const record = { banners: [], notes: [], rerenders: 0 };
  const host = {
    index: 0,
    body: controls.body,
    uplotHost: new FakeElement(),
    canvas: new FakeElement('canvas'),
    tip: new FakeElement(),
    tags: [new FakeElement(), new FakeElement()],
    legendHost: new FakeElement(),
    controls,
    size: () => size,
    banner: (kind, text) => record.banners.push({ kind, text }),
    note: (text) => record.notes.push(text),
    rerender: () => record.rerenders++,
    datesChange: () => {},
  };
  return { host, record };
}

/** One render's frame over `series`, every one of them drawn. */
export function frameOf(series, input = {}) {
  return {
    input: {
      boxDims: ['case', 'case', 'case', 'case'],
      series,
      boxes: () => [],
      hasCases: true,
      dates: null,
      ...input,
    },
    drawable: series.filter((s) => s.values !== null),
    zeroText: null,
    wholeYear: () => [],
  };
}

/** The global chrome `createChrome` resolves by id, as index.html lays it
 * out, under one root. */
export function fakeChrome() {
  const chrome = new FakeElement();
  for (const id of [
    'status-text',
    'status-spinner',
    'busy-bar',
    'memory-readout',
    'add-cases-btn',
    'save-btn',
    'load-btn',
    'rail-toggle-btn',
  ]) {
    chrome.appendChild(new FakeElement(/btn|readout/.test(id) ? 'button' : 'span')).id = id;
  }
  return chrome;
}

/** A keydown as the shell's one document listener receives it. */
export function keydown(key, target = null) {
  return { key, target, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} };
}
