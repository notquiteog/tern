// A browser-shaped global scope for node:test. Imported first by the tests
// that touch DOMParser, Range or document.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
for (const k of ['window', 'document', 'DOMParser', 'Node', 'NodeFilter', 'Range', 'HTMLElement', 'Element', 'DocumentFragment', 'localStorage']) {
  if (!(k in g) || k === 'localStorage') g[k] = k === 'window' ? dom.window : (dom.window as any)[k];
}
export const jsdom = dom;
