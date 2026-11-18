import assert from 'node:assert/strict';
import { gradeAlt, needsAI, ruleDecorative, shouldEscalate, tidyAlt, type PageImage } from './rules.ts';

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

const base: PageImage = {
  id: 0, src: '', alt: null, width: 400, height: 300, naturalWidth: 800, naturalHeight: 600,
  hidden: false, role: null, ariaHidden: false, linkHref: null, linkText: '', caption: '', heading: '', nearbyText: '',
};
assert.equal(ruleDecorative(base), null);
assert.equal(ruleDecorative({ ...base, naturalWidth: 1, naturalHeight: 1 }), 'Spacer pixel');
assert.equal(ruleDecorative({ ...base, naturalWidth: 0, naturalHeight: 0 }), null); // broken, not a spacer
assert.equal(ruleDecorative({ ...base, width: 16, height: 16 }), 'Smaller than 24 px');
assert.equal(ruleDecorative({ ...base, role: 'presentation' }), 'role="presentation"');

assert.equal(needsAI(base, 'ok'), false);
assert.equal(needsAI(base, 'empty'), true);
assert.equal(needsAI({ ...base, width: 40, height: 40 }, 'empty'), false);
assert.equal(needsAI(base, 'missing'), true);

assert.equal(shouldEscalate({ kind: 'complex', has_people: false, has_text: true, alt: '' }), true);
assert.equal(shouldEscalate({ kind: 'complex', has_people: true, has_text: true, alt: '' }), false);
assert.equal(shouldEscalate({ kind: 'informative', has_people: false, has_text: false, alt: '' }), false);
assert.equal(shouldEscalate({ kind: 'informative', has_people: false, has_text: true, alt: '' }), true);
assert.equal(shouldEscalate({ kind: 'functional', has_people: false, has_text: true, alt: '' }), false); // logo link

assert.equal(tidyAlt('image of a red bus'), 'A red bus');
const long = tidyAlt('word '.repeat(40));
assert.ok(long.length <= 125 && long.endsWith('…'));

console.log('rules: all checks passed');
