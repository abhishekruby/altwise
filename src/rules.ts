// Checks that need no AI. Pure functions, so rules.test.ts can run them in Node.

export type AltGrade = 'missing' | 'empty' | 'filename' | 'generic' | 'too-long' | 'redundant' | 'ok';

export interface PageImage {
  id: number;
  src: string;
  alt: string | null; // null = attribute missing
  width: number; // rendered size in CSS px
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  hidden: boolean;
  role: string | null;
  ariaHidden: boolean;
  linkHref: string | null;
  linkText: string;
  caption: string;
  heading: string;
  nearbyText: string;
}

const FILE_EXT = /\.(jpe?g|png|gif|webp|svg|avif|bmp)$/i;
const CAMERA_NAME = /^(img|dsc|dscn|pxl|image|photo|screenshot)[\s_-]?\d+/i;
const GENERIC = /^(an? |the )?(image|picture|pic|photo|photograph|graphic|logo|icon|img|banner|spacer|placeholder|untitled|chart|graph|diagram|map|poster|flyer|infographic|figure|screenshot|button|link|click here)( \d+)?$/i;
const REDUNDANT = /^(an? )?(image|picture|photo|graphic) (of|showing)\b/i;

export function gradeAlt(alt: string | null): AltGrade {
  if (alt === null) return 'missing';
  const a = alt.trim();
  if (a === '') return 'empty';
  if (FILE_EXT.test(a) || CAMERA_NAME.test(a)) return 'filename';
  if (GENERIC.test(a)) return 'generic';
  if (a.length > 150) return 'too-long';
  if (REDUNDANT.test(a)) return 'redundant';
  return 'ok';
}

export const GRADE_LABEL: Record<AltGrade, string> = {
  missing: 'No alt attribute',
  empty: 'Empty alt',
  filename: 'Alt is a file name',
  generic: 'Alt is too generic',
  'too-long': 'Alt is too long',
  redundant: 'Starts with "image of"',
  ok: 'Alt looks fine',
};

/** Returns a reason if the image is clearly decorative or hidden, so the model can skip it. */
export function ruleDecorative(img: PageImage): string | null {
  if (img.hidden) return 'Hidden from view';
  if (img.ariaHidden) return 'aria-hidden="true"';
  if (img.role === 'presentation' || img.role === 'none') return `role="${img.role}"`;
  // naturalWidth 0 means the image failed to load, which is not the same as a spacer.
  if (img.naturalWidth > 0 && (img.naturalWidth <= 2 || img.naturalHeight <= 2)) return 'Spacer pixel';
  if (img.width < 24 && img.height < 24) return 'Smaller than 24 px';
  return null;
}

/** Should this image get an AI pass? Fine alt text and deliberate empty alt on small images are left alone. */
export function needsAI(img: PageImage, grade: AltGrade): boolean {
  if (grade === 'ok') return false;
  if (grade === 'empty') return img.width >= 100 && img.height >= 60; // big image marked decorative is suspicious
  return true;
}

export type Kind = 'decorative' | 'informative' | 'functional' | 'complex';

export interface Classification {
  kind: Kind;
  has_people: boolean;
  has_text: boolean;
  alt: string;
}

/**
 * Privacy rule: an image with people in it never goes to the cloud.
 * Charts, infographics and text-heavy images do, because the on-device model
 * sees them at 768x768 and cannot read small numbers reliably.
 * Logos and link images contain text too, but their alt names the destination, so they stay local.
 */
export function shouldEscalate(c: Classification): boolean {
  if (c.has_people) return false;
  return c.kind === 'complex' || (c.has_text && c.kind === 'informative');
}

/** Cleans model alt text: trims, drops "Image of", caps length at a word boundary. */
export function tidyAlt(alt: string, max = 125): string {
  let a = alt.trim().replace(/\s+/g, ' ').replace(REDUNDANT, '').trim();
  a = a.charAt(0).toUpperCase() + a.slice(1);
  if (a.length <= max) return a;
  const cut = a.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}
