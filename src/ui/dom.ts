// src/ui/dom.ts
//
// The ONLY element-lookup helper in the app.
//
// Two sections mounted at once are two clones of the same
// `<template id="section-template">`, so every `data-` hook inside a section
// exists once PER SECTION. A global by-id lookup would resolve to whichever
// clone happens to be first in the document and would silently wire one
// section's controls to another section's charts -- one working chart set and
// one dead one, with nothing thrown.
//
// So: no module under `src/ui/` or `src/tables/*/ui/` looks an element up
// globally. Each is handed a root -- the section's own root element, or a
// modal's own subtree -- and resolves inside it with `within`.
// `tests/test_dom_contract.mjs` enforces that as a static scan of these sources.

/**
 * The one element matching `selector` inside `root`.
 *
 * Throws rather than returning null: every hook this app resolves is written
 * into `index.html`'s template, so a miss is a typo or a renamed hook, never a
 * legitimate absence, and a null that flows on surfaces far from its cause.
 * The message names the selector AND the root's class list, because with two
 * sections mounted "not found" is ambiguous until you know which section.
 */
export function within<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    const where = root.className
      ? `.${root.className.split(/\s+/).join('.')}`
      : `<${root.tagName.toLowerCase()}>`;
    throw new Error(`no ${selector} inside ${where}`);
  }
  return element;
}
