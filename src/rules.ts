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
  linkHome: boolean; // the link goes to this site's home page (typical for logos)
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
  // Only trust the rendered size once the image has loaded: a lazy image waiting offscreen measures 0x0.
  if (img.naturalWidth > 0 && img.width < 24 && img.height < 24) return 'Smaller than 24 px';
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
 * Privacy rule: a photo of a person never goes to the cloud.
 * Charts, infographics and text-heavy images do, because the on-device model
 * sees them at 768x768 and cannot read small numbers reliably.
 * Logos and link images contain text too, but their alt names the destination, so they stay local.
 * `hasPhoto` comes from photoTiles(): a drawing with no photographic pixels cannot show a real person,
 * even if the model saw stick figures or icons of people in it.
 */
export function shouldEscalate(c: Classification, escalateText = true, hasPhoto = true): boolean {
  if (c.has_people && hasPhoto) return false;
  return c.kind === 'complex' || (escalateText && c.has_text && c.kind === 'informative');
}

/**
 * Counts 16 px tiles that look like part of a photograph. In drawn graphics (charts, maps, text,
 * icons) most neighbouring pixels are identical, even around anti-aliased edges. In photos, sensor
 * noise and texture make identical neighbours rare, in colour and in black and white alike.
 * A tiny photo pasted into a flyer still produces a few such tiles.
 * ponytail: a heuristic. JPEG-compressed charts and gradients can count as photo-like; that only
 * costs one extra on-device check, never a privacy leak.
 */
export function photoTiles(rgba: Uint8ClampedArray, width: number, height: number, tile = 16): number {
  let photo = 0;
  for (let ty = 0; ty + tile <= height; ty += tile) {
    for (let tx = 0; tx + tile <= width; tx += tile) {
      let same = 0, pairs = 0;
      const levels = new Set<number>();
      for (let y = ty; y < ty + tile; y++) {
        for (let x = tx; x < tx + tile; x++) {
          const i = (y * width + x) * 4;
          levels.add(((rgba[i] * 3 + rgba[i + 1] * 6 + rgba[i + 2]) / 10) | 0);
          if (x + 1 < tx + tile) {
            pairs++;
            if (Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 5]) + Math.abs(rgba[i + 2] - rgba[i + 6]) <= 3) same++;
          }
        }
      }
      if (same / pairs < 0.35 && levels.size >= 32) photo++;
    }
  }
  return photo;
}

/** Cleans model alt text: trims, drops "Image of", caps length at a word boundary. */
export function tidyAlt(alt: string, max = 125): string {
  let a = alt.trim().replace(/\s+/g, ' ').replace(REDUNDANT, '').trim();
  a = a.charAt(0).toUpperCase() + a.slice(1);
  if (a.length <= max) return a;
  const cut = a.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}
