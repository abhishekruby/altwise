// Checks that need no AI. Pure functions, so rules.test.ts can run them in Node.

export type AltGrade = 'missing' | 'empty' | 'filename' | 'generic' | 'label-only' | 'too-long' | 'redundant' | 'ok';

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
// A file name with the extension dropped: "TOJ_Badge_Logo_banner_size", "spring-concert-2026".
const BARE_FILENAME = /^\S+$/;
const FILE_SEPARATORS = /_|-.*-/;
// Names a text-heavy image without saying what it says: "Summer Recreation Program Flyer", "Lunch menu".
// Seen on real town and school sites, where the dates, times and prices exist only inside the image.
const LABEL_ONLY = /^(\S+\s){0,5}(flyers?|posters?|infographics?|announcements?|banners?|schedules?|menus?|calendars?|newsletters?|brochures?|handouts?|forms?|timetables?|notices?|letters?)$/i;

export function gradeAlt(alt: string | null): AltGrade {
  if (alt === null) return 'missing';
  const a = alt.trim();
  if (a === '') return 'empty';
  if (FILE_EXT.test(a) || CAMERA_NAME.test(a) || (BARE_FILENAME.test(a) && FILE_SEPARATORS.test(a))) return 'filename';
  if (GENERIC.test(a)) return 'generic';
  if (LABEL_ONLY.test(a)) return 'label-only';
  if (a.length > 150) return 'too-long';
  if (REDUNDANT.test(a)) return 'redundant';
  return 'ok';
}

export const GRADE_LABEL: Record<AltGrade, string> = {
  missing: 'No alt attribute',
  empty: 'Empty alt',
  filename: 'Alt is a file name',
  generic: 'Alt is too generic',
  'label-only': 'Alt names it, not what it says',
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
 * Does this image need the bigger cloud model? Charts, infographics and text-heavy images do, because
 * the on-device model sees them at 768x768 and cannot read small numbers reliably.
 * Logos and link images contain text too, but their alt names the destination, so they stay local.
 * Whether the image may actually leave the device is decided separately, by the privacy checks.
 */
export function wantsCloud(c: Classification, escalateText = true): boolean {
  return c.kind === 'complex' || (escalateText && c.has_text && c.kind === 'informative');
}

/**
 * Finds 16 px tiles that look like part of a photograph and returns their top-left corners.
 * In drawn graphics (charts, maps, text, icons) most neighbouring pixels are identical, even around
 * anti-aliased edges. In photos, sensor noise and texture make identical neighbours rare, in colour
 * and in black and white alike. A drawing with no such tiles cannot show a real person, and a small
 * photo pasted into a flyer still produces a few, which tells us exactly where it is.
 * Text needs a second test: in a JPEG scan of a letter, compression noise around the letters also
 * breaks up identical neighbours. But a text tile is two-tone (ink and paper plus fuzz), so most of
 * its pixels sit near its darkest or lightest value, while a photo tile is spread across midtones.
 * ponytail: a heuristic. Gradients and noisy charts can still count as photo-like; that only costs
 * one extra on-device check or keeps an image local, never a privacy leak.
 */
export function photoRegions(rgba: Uint8ClampedArray, width: number, height: number, tile = 16): [number, number][] {
  const found: [number, number][] = [];
  const seen = new Uint32Array(256); // brightness level -> last tile that used it, so no per-tile allocation
  const lums = new Uint8Array(tile * tile);
  let tileNo = 0;
  for (let ty = 0; ty + tile <= height; ty += tile) {
    for (let tx = 0; tx + tile <= width; tx += tile) {
      let same = 0, pairs = 0, levels = 0, lo = 255, hi = 0, k = 0;
      tileNo++;
      for (let y = ty; y < ty + tile; y++) {
        for (let x = tx; x < tx + tile; x++) {
          const i = (y * width + x) * 4;
          const l = ((rgba[i] * 3 + rgba[i + 1] * 6 + rgba[i + 2]) / 10) | 0;
          if (seen[l] !== tileNo) { seen[l] = tileNo; levels++; }
          lums[k++] = l;
          if (l < lo) lo = l;
          if (l > hi) hi = l;
          if (x + 1 < tx + tile) {
            pairs++;
            if (Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 5]) + Math.abs(rgba[i + 2] - rgba[i + 6]) <= 3) same++;
          }
        }
      }
      if (same / pairs >= 0.35 || levels < 32) continue;
      const band = Math.max(24, ((hi - lo) / 5) | 0);
      let extremes = 0;
      for (let i = 0; i < k; i++) if (lums[i] - lo <= band || hi - lums[i] <= band) extremes++;
      if (extremes / k < 0.75) found.push([tx, ty]);
    }
  }
  return found;
}

/** A flyer with a small photo can have the photo blanked out. A photo with a caption cannot. */
export function redactable(photoTiles: number, width: number, height: number, tile = 16): boolean {
  const total = Math.floor(width / tile) * Math.floor(height / tile);
  return photoTiles > 0 && total > 0 && photoTiles / total < 0.4;
}

/** Cleans model alt text: trims, drops "Image of", caps length at a word boundary. */
export function tidyAlt(alt: string, max = 125): string {
  let a = alt.trim().replace(/\s+/g, ' ').replace(REDUNDANT, '').trim();
  a = a.charAt(0).toUpperCase() + a.slice(1);
  if (a.length <= max) return a;
  const cut = a.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}
