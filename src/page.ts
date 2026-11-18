// Functions injected into the audited tab with chrome.scripting.executeScript.
// Each must be self-contained: no imports, no outer variables.

import type { PageImage } from './rules.ts';

export interface PdfLink { href: string; text: string }

export function collectFromPage(): { images: PageImage[]; pdfs: PdfLink[]; title: string; url: string } {
  const clip = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  const headingFor = (el: Element): string => {
    // Walk back through previous siblings and ancestors to the nearest heading.
    let node: Element | null = el;
    while (node && node !== document.body) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return clip(sib.textContent, 120);
        const inner = sib.querySelector('h1,h2,h3,h4,h5,h6');
        if (inner) return clip(inner.textContent, 120);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return clip(document.querySelector('h1')?.textContent, 120);
  };

  const nearbyFor = (el: Element): string => {
    let p: Element | null = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = clip(p.textContent, 300);
      if (t.length > 40) return t;
    }
    return '';
  };

  const images: PageImage[] = [];
  document.querySelectorAll('img').forEach((img, id) => {
    img.dataset.altwiseId = String(id);
    const r = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const link = img.closest('a');
    images.push({
      id,
      src: img.currentSrc || img.src,
      alt: img.getAttribute('alt'),
      width: Math.round(r.width),
      height: Math.round(r.height),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      hidden: style.display === 'none' || style.visibility === 'hidden' || (r.width === 0 && r.height === 0),
      role: img.getAttribute('role'),
      ariaHidden: img.closest('[aria-hidden="true"]') !== null,
      linkHref: link?.href ?? null,
      linkText: clip(link?.textContent, 120),
      caption: clip(img.closest('figure')?.querySelector('figcaption')?.textContent, 200),
      heading: headingFor(img),
      nearbyText: nearbyFor(img),
    });
  });

  const pdfs: PdfLink[] = [];
  const seen = new Set<string>();
  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    if (!/\.pdf($|[?#])/i.test(a.pathname + a.search) || seen.has(a.href)) return;
    seen.add(a.href);
    pdfs.push({ href: a.href, text: clip(a.textContent, 120) });
  });

  return { images, pdfs, title: document.title, url: location.href };
}

export function highlightOnPage(id: number): void {
  const img = document.querySelector<HTMLImageElement>(`img[data-altwise-id="${id}"]`);
  if (!img) return;
  img.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const old = img.style.outline;
  img.style.outline = '4px solid #e8590c';
  img.style.outlineOffset = '3px';
  setTimeout(() => { img.style.outline = old; }, 2500);
}

export function applyAltOnPage(id: number, alt: string): void {
  const img = document.querySelector<HTMLImageElement>(`img[data-altwise-id="${id}"]`);
  if (img) img.setAttribute('alt', alt);
}
