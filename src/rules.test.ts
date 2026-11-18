import assert from 'node:assert/strict';
import { gradeAlt, needsAI, photoRegions, redactable, ruleDecorative, tidyAlt, wantsCloud, type PageImage } from './rules.ts';

assert.equal(gradeAlt(null), 'missing');
assert.equal(gradeAlt('  '), 'empty');
assert.equal(gradeAlt('IMG_2041.JPG'), 'filename');
assert.equal(gradeAlt('DSC 0042'), 'filename');
assert.equal(gradeAlt('school-photo.png'), 'filename');
assert.equal(gradeAlt('image'), 'generic');
assert.equal(gradeAlt('Logo'), 'generic');
assert.equal(gradeAlt('chart'), 'generic');
assert.equal(gradeAlt('Poster'), 'generic');
assert.equal(gradeAlt('Map of the school'), 'ok');
assert.equal(gradeAlt('Image of a girl reading'), 'redundant');
assert.equal(gradeAlt('x'.repeat(151)), 'too-long');
assert.equal(gradeAlt('Students planting trees in the school garden'), 'ok');
// Seen on real sites (November 2026)
assert.equal(gradeAlt('TOJ_Badge_Logo_banner_size'), 'filename');
assert.equal(gradeAlt('spring-concert-2026'), 'filename');
assert.equal(gradeAlt('Wi-Fi'), 'ok');
assert.equal(gradeAlt('Summer Recreation Program Flyer'), 'label-only');
assert.equal(gradeAlt('Summer program announcement'), 'label-only');
assert.equal(gradeAlt('Aldrin ES banner'), 'label-only');
assert.equal(gradeAlt('Lunch menu'), 'label-only');
assert.equal(gradeAlt('Return to Home'), 'ok');
assert.equal(gradeAlt('Download our iOS App'), 'ok');
assert.equal(gradeAlt('Flyer for the spring bake sale on April 10, 3 to 5 PM in the gym'), 'ok');

const base: PageImage = {
  id: 0, src: '', alt: null, width: 400, height: 300, naturalWidth: 800, naturalHeight: 600,
  hidden: false, role: null, ariaHidden: false, linkHref: null, linkHome: false, linkText: '', caption: '', heading: '', nearbyText: '',
};
assert.equal(ruleDecorative(base), null);
assert.equal(ruleDecorative({ ...base, naturalWidth: 1, naturalHeight: 1 }), 'Spacer pixel');
assert.equal(ruleDecorative({ ...base, naturalWidth: 0, naturalHeight: 0 }), null); // broken, not a spacer
assert.equal(ruleDecorative({ ...base, width: 16, height: 16 }), 'Smaller than 24 px');
assert.equal(ruleDecorative({ ...base, role: 'presentation' }), 'role="presentation"');
assert.equal(ruleDecorative({ ...base, width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 }), null); // lazy, not loaded yet

assert.equal(needsAI(base, 'ok'), false);
assert.equal(needsAI(base, 'empty'), true);
assert.equal(needsAI({ ...base, width: 40, height: 40 }, 'empty'), false);
assert.equal(needsAI(base, 'missing'), true);

assert.equal(wantsCloud({ kind: 'complex', has_people: false, has_text: true, alt: '' }), true);
assert.equal(wantsCloud({ kind: 'informative', has_people: false, has_text: false, alt: '' }), false);
assert.equal(wantsCloud({ kind: 'informative', has_people: true, has_text: true, alt: '' }), true);
assert.equal(wantsCloud({ kind: 'informative', has_people: false, has_text: true, alt: '' }, false), false);
assert.equal(wantsCloud({ kind: 'functional', has_people: false, has_text: true, alt: '' }), false); // logo link

// photoRegions: flat drawing with a hard-edged shape = 0; any noisy (photo-like) patch, colour or grey > 0.
const W = 64, H = 64;
const flat = new Uint8ClampedArray(W * H * 4).fill(255);
for (let y = 20; y < 40; y++) for (let x = 10; x < 50; x++) { const i = (y * W + x) * 4; flat[i] = 47; flat[i + 1] = 91; flat[i + 2] = 211; }
assert.deepEqual(photoRegions(flat, W, H), []);
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const grey = flat.slice();
for (let y = 0; y < 16; y++) for (let x = 48; x < 64; x++) { const i = (y * W + x) * 4, v = 40 + rnd() * 180; grey[i] = grey[i + 1] = grey[i + 2] = v; }
assert.deepEqual(photoRegions(grey, W, H), [[48, 0]]);
assert.equal(redactable(1, W, H), true); // 1 of 16 tiles is photo: blank it out
assert.equal(redactable(12, W, H), false); // mostly photo: keep it local
assert.equal(redactable(0, W, H), false);

assert.equal(tidyAlt('image of a red bus'), 'A red bus');
const long = tidyAlt('word '.repeat(40));
assert.ok(long.length <= 125 && long.endsWith('…'));

// PDF checks against the generated demo files (python3 dev/make_assets.py)
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { factsFromText, pdfFacts, vagueLinkText } from './pdf.ts';

const load = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const news = await pdfFacts(load('demo/docs/winter-newsletter.pdf'));
assert.deepEqual(news, { tagged: false, title: false, lang: false, hasText: true });
const scan = await pdfFacts(load('demo/docs/lunch-form.pdf'));
assert.equal(scan.hasText, false);

// A tagged catalog hidden inside a compressed object stream must still be found.
const hidden = deflateSync('<< /Type /Catalog /StructTreeRoot 9 0 R /Lang (en-US) >>');
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n5 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n'), hidden,
  Buffer.from('\nendstream\nendobj\n6 0 obj << /Title (Lunch form) >> endobj')]);
const tagged = await pdfFacts(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
assert.equal(tagged.tagged, true);
assert.equal(tagged.lang, true);
assert.equal(tagged.title, true);
assert.equal(factsFromText('/Title ()').title, false);
assert.equal(factsFromText('/Title (lunch-form)').title, false); // file name, not a title
assert.equal(factsFromText('/Title (Microsoft Word - menu.docx)').title, false);
assert.equal(factsFromText('/Title (Lunch application 2026)').title, true);

assert.equal(vagueLinkText('click here'), true);
assert.equal(vagueLinkText('Download'), true);
assert.equal(vagueLinkText('menu.pdf'), true);
assert.equal(vagueLinkText('Winter newsletter (PDF)'), false);

console.log('rules: all checks passed');
