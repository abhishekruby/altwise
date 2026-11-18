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

  // Lazy-loading scripts keep the real file in data-src and put a placeholder in src.
  const realSrc = (img: HTMLImageElement): string => {
    const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.original
      || (img.dataset.srcset || img.dataset.lazySrcset || '').trim().split(/\s+/)[0];
    const current = img.currentSrc || img.src;
    const placeholder = !current || current.startsWith('data:') || (img.complete && img.naturalWidth > 0 && img.naturalWidth <= 2);
    if (lazy && placeholder) {
      try { return new URL(lazy, document.baseURI).href; } catch { /* keep current */ }
    }
    return current;
  };

  const images: PageImage[] = [];
  document.querySelectorAll('img').forEach((img, id) => {
    img.dataset.altwiseId = String(id);
    const r = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const link = img.closest('a');
    const src = realSrc(img);
    const swapped = src !== (img.currentSrc || img.src);
    images.push({
      id,
      src,
      alt: img.getAttribute('alt'),
      width: Math.round(r.width),
      height: Math.round(r.height),
      // A placeholder's size says nothing about the real image, and 0 means "not loaded yet".
      naturalWidth: swapped ? 0 : img.naturalWidth,
      naturalHeight: swapped ? 0 : img.naturalHeight,
      // A lazy image that has not loaded yet can measure 0x0 without being hidden.
      hidden: style.display === 'none' || style.visibility === 'hidden' || (img.complete && !swapped && r.width === 0 && r.height === 0),
      role: img.getAttribute('role'),
      ariaHidden: img.closest('[aria-hidden="true"]') !== null,
      linkHref: link?.href ?? null,
      linkHome: !!link && link.origin === location.origin && (link.pathname === '/' || link.pathname === location.pathname),
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

/** Puts a small label on the image in the audited page so you can watch the routing happen. */
export function markOnPage(id: number, text: string, tone: 'working' | 'device' | 'cloud' | 'rules', scroll: boolean): void {
  const img = document.querySelector<HTMLImageElement>(`img[data-altwise-id="${id}"]`);
  if (!img) return;
  const colors = { working: '#e8590c', device: '#0d7a5f', cloud: '#2f5bd3', rules: '#5d6470' };
  let tag = document.querySelector<HTMLElement>(`[data-altwise-tag="${id}"]`);
  if (!tag) {
    tag = document.createElement('div');
    tag.dataset.altwiseTag = String(id);
    tag.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tag);
  }
  if (scroll) img.scrollIntoView({ behavior: 'instant', block: 'center' });
  const r = img.getBoundingClientRect();
  Object.assign(tag.style, {
    position: 'absolute', left: `${r.left + scrollX + 8}px`, top: `${r.top + scrollY + 8}px`, zIndex: '2147483647',
    background: colors[tone], color: '#fff', font: '600 12px/1.2 system-ui, sans-serif', padding: '5px 10px',
    borderRadius: '999px', boxShadow: '0 2px 6px rgba(0,0,0,.35)', pointerEvents: 'none', whiteSpace: 'nowrap',
  });
  tag.textContent = text;
  img.style.outline = `3px ${tone === 'working' ? 'dashed' : 'solid'} ${colors[tone]}`;
  img.style.outlineOffset = '2px';
}

export function clearMarks(): void {
  document.querySelectorAll('[data-altwise-tag]').forEach((e) => e.remove());
  document.querySelectorAll<HTMLElement>('img[data-altwise-id]').forEach((i) => { i.style.outline = ''; });
}

export function applyAltOnPage(id: number, alt: string): void {
  const img = document.querySelector<HTMLImageElement>(`img[data-altwise-id="${id}"]`);
  if (img) img.setAttribute('alt', alt);
}
