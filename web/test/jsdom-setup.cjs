// Preloaded (`node --require`) before the web view smoke tests: gives the
// compiled bundle a browser-like global environment (jsdom) and the shims the
// UI kit expects. Plain CommonJS on purpose: no TypeScript in the web tree.
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://127.0.0.1:5174/",
  pretendToBeVisual: true,
});
const { window } = dom;

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

for (const name of ["window", "document", "localStorage", "history", "location", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver"]) {
  define(name, window[name]);
}
define("navigator", window.navigator);
define("IS_REACT_ACT_ENVIRONMENT", false); // smoke tests wait on timers instead of act()

window.matchMedia = window.matchMedia || ((query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}));
class Noop { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
window.ResizeObserver = window.ResizeObserver || Noop;
window.IntersectionObserver = window.IntersectionObserver || Noop;
define("matchMedia", window.matchMedia);
define("ResizeObserver", window.ResizeObserver);
define("IntersectionObserver", window.IntersectionObserver);

// jsdom has no layout: stub what the chat widget calls.
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || function () {};
