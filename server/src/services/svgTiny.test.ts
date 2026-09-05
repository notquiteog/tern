import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToBimi, roundNumbers, toTinyPs } from './svgTiny.js';

const MESSY = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="x" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="100px" height="100px" version="1.1" id="svg1" inkscape:version="1.3" sodipodi:docname="logo.svg" x="0" y="0">
  <title>Original title with secrets</title>
  <desc>Made by Jane Doe, 2024</desc>
  <metadata><rdf:RDF xmlns:rdf="r"><cc:Work>author</cc:Work></rdf:RDF></metadata>
  <defs id="defs1"><linearGradient id="grad1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:#ff0000;stop-opacity:1"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
  <sodipodi:namedview id="nv" pagecolor="#ffffff"/>
  <g id="layer1" inkscape:label="Layer 1" inkscape:groupmode="layer" style="fill:url(#grad1);stroke:none" data-name="thing">
    <path id="path1" class="cls-1" d="M 10.123456,10.987654 L 90.5,10.5 90.4999,90.0001 Z" onclick="alert(1)" />
    <a href="https://example.com"><rect x="1" y="1" width="10" height="10" fill="#000"/></a>
    <image href="https://example.com/x.png" width="10" height="10"/>
    <text x="5" y="50" style="font-size:12px;font-family:Arial">Hi &amp; bye</text>
  </g>
</svg>`;

test('toTinyPs strips metadata, editor attributes, scripts and external references', () => {
  const r = toTinyPs(MESSY, { title: 'Acme' });
  assert.ok(r.ok);
  if (!r.ok) return;
  const s = r.svg;
  assert.ok(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"'));
  assert.ok(s.includes('<title>Acme</title>'));
  for (const bad of ['inkscape', 'sodipodi', 'metadata', 'Jane Doe', 'secrets', 'onclick', 'data-name', 'class=', 'DOCTYPE', '<!--', 'example.com', '<image', '<a ', 'id="path1"', 'id="layer1"', 'xmlns:inkscape']) assert.ok(!s.includes(bad), `still contains ${bad}`);
  assert.ok(s.includes('id="grad1"'), 'referenced gradient id kept');
  assert.ok(s.includes('fill="url(#grad1)"'), 'style converted to attribute');
  assert.ok(s.includes('stop-color="#ff0000"'));
  assert.ok(s.includes('<rect x="1" y="1" width="10" height="10" fill="#000"/>'), 'unwrapped link keeps the rect');
  assert.ok(s.includes('font-size="12px"'));
  assert.ok(s.includes('Hi &amp; bye'));
  assert.ok(s.includes('M10.123,10.988L90.5,10.5 90.5,90Z'), s);
  assert.ok(r.report.removedElements.metadata === 1 && r.report.removedElements.desc === 1 && r.report.removedElements.image === 1);
  assert.ok(r.report.removedAttributes >= 8 && r.report.stylesConverted >= 3);
});

test('fitToBimi lowers precision until it fits and reports failure honestly', () => {
  const big = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + Array.from({ length: 900 }, (_, i) => `<path d="M${i}.123456,${i}.654321 L${i + 1}.111111,${i + 2}.222222 Z"/>`).join('') + '</svg>';
  const r = fitToBimi(big);
  assert.ok(r.ok && r.bytes <= 32 * 1024 && r.report.precision < 3, r.ok ? String(r.report.precision) : r.error);
  const huge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + Array.from({ length: 6000 }, (_, i) => `<path d="M${i} ${i}L${i + 1} ${i + 2}Z"/>`).join('') + '</svg>';
  const h = fitToBimi(huge);
  assert.ok(!h.ok && h.error.includes('32 KB'));
});

test('roundNumbers keeps integers and trims zeros', () => {
  assert.equal(roundNumbers('M 1.5000 2.0001 -3.14159', 2), 'M 1.5 2 -3.14');
});

test('unsafe documents are rejected', () => {
  assert.equal(toTinyPs('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>').ok, false);
  assert.equal(toTinyPs('<div>nope</div>').ok, false);
});
