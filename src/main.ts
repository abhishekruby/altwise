import type { Part } from 'firebase/ai';
import { classify, describe, deviceAvailability, hasPeopleOnDevice, initDevice, loadSettings, reviewPdf, settings, type PdfReview, type Source } from './ai.ts';
import { applyAltOnPage, clearMarks, collectFromPage, highlightOnPage, markOnPage, type PdfLink } from './page.ts';
import { pdfFacts, vagueLinkText, type PdfFacts } from './pdf.ts';
import {
  GRADE_LABEL, gradeAlt, needsAI, photoRegions, redactable, ruleDecorative, tidyAlt, wantsCloud,
  type AltGrade, type Kind, type PageImage,
} from './rules.ts';

type Status = 'skipped' | 'fine' | 'queued' | 'working' | 'review' | 'accepted' | 'error';

interface Item {
  img: PageImage;
  grade: AltGrade;
  status: Status;
  note: string; // why it was skipped, routed or failed
  kind?: Kind;
  hasPeople?: boolean;
  suggestion?: string;
  longDescription?: string;
  sources: Source[]; // every place this image was processed
  ms: { device?: number; cloud?: number };
  thumb?: string;
  cloudView?: string; // what the cloud was sent, when a photo of people was blanked out first
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface PdfItem {
  link: PdfLink;
  status: 'queued' | 'working' | 'done' | 'error';
  facts?: PdfFacts;
  review?: PdfReview;
  sizeKb?: number;
  note?: string;
}

let items: Item[] = [];
let pdfs: PdfItem[] = [];
let page = { title: '', url: '' };
let tabId = 0;
let filter: 'todo' | 'all' | 'pdf' = 'todo';
let strict = false;
let busy = false;
let cloudOk = false; // the person agreed to cloud processing while Gemini Nano is missing
let scanMs = 0;
const testTarget = new URLSearchParams(location.search).get('target'); // lets the panel run in a normal tab for testing

// ---------- on-device model status ----------

let downloadTried = false;
let pollTimer = 0;
let availability = 'unsupported';

async function refreshDevice() {
  availability = await deviceAvailability();
  const chip = $('#device');
  const text: Record<string, string> = {
    available: 'Gemini Nano ready',
    downloadable: downloadTried ? 'No Nano here · using cloud' : 'Gemini Nano not downloaded',
    downloading: 'Nano downloading · cloud for now',
    unavailable: 'No Nano here · using cloud',
    unsupported: 'No Nano here · using cloud',
  };
  chip.textContent = text[availability] ?? availability;
  chip.dataset.state = availability === 'available' ? 'ok' : availability === 'downloading' || (availability === 'downloadable' && !downloadTried) ? 'wait' : 'off';
  return availability;
}

/** Starts the Nano download (needs a click) and polls until Chrome reports the model ready. */
function startDownload() {
  downloadTried = true;
  initDevice((f) => { $('#device').textContent = f < 1 ? `Downloading Gemini Nano ${Math.round(f * 100)}%` : 'Installing Gemini Nano…'; })
    .catch(() => {});
  clearInterval(pollTimer);
  let polls = 0;
  pollTimer = window.setInterval(async () => {
    const a = await refreshDevice();
    if (a === 'available' || ++polls > 60) clearInterval(pollTimer);
  }, 5000);
}

/**
 * Without Gemini Nano, PREFER_ON_DEVICE sends every image to the cloud, photos of people included.
 * Ask once per panel session before that happens. Strict privacy never falls back, so it never asks.
 */
async function mayUseCloud(): Promise<boolean> {
  if (strict || cloudOk || availability === 'available') return true;
  const d = $('#cloud-ask') as HTMLDialogElement;
  $('#cloud-ask-why').textContent = availability === 'downloading' || availability === 'downloadable'
    ? 'It is still downloading. Once it is ready, scans run on this computer again.'
    : 'This computer or browser cannot run it. Chrome needs a GPU with more than 4 GB of memory, or 16 GB of RAM.';
  d.showModal();
  // Listen to the buttons and Esc directly: in some Chrome builds the dialog's close event never arrives.
  const choice = await new Promise<string>((resolve) => {
    for (const b of d.querySelectorAll('button')) b.addEventListener('click', () => resolve(b.value), { once: true });
    d.addEventListener('cancel', () => resolve('cancel'), { once: true });
    d.addEventListener('close', () => resolve(d.returnValue), { once: true });
  });
  d.close();
  cloudOk = choice === 'cloud';
  return cloudOk;
}

// ---------- image loading ----------

/** Scales a canvas down to fit `max`, for small previews. */
function toCanvasFrom(src: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Draws the image scaled to fit `max`. With `square`, it is centred on a white square instead:
 * Gemini Nano stretches every image to a square, which squashes logos, banners and wide charts.
 */
function toCanvas(el: HTMLImageElement, max: number, square = false): HTMLCanvasElement {
  const w0 = el.naturalWidth || 300, h0 = el.naturalHeight || 150;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = square ? Math.max(w, h) : w;
  canvas.height = square ? Math.max(w, h) : h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(el, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  return canvas;
}

const jpeg = (c: HTMLCanvasElement): Part => ({ type: 'inlineData', inlineData: { mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] } });

/** Fetches the image once: a padded square for Gemini Nano, the natural shape for the cloud, a thumbnail,
 * and where any photographic areas are (drawings cannot show a real person). */
async function loadImage(src: string) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  try {
    const el = new Image();
    el.src = url;
    await el.decode();
    const natural = toCanvas(el, 1536);
    const pixels = natural.getContext('2d')!.getImageData(0, 0, natural.width, natural.height).data;
    return {
      part: jpeg(toCanvas(el, 768, true)), natural, thumb: toCanvas(el, 160).toDataURL('image/jpeg', 0.8),
      regions: photoRegions(pixels, natural.width, natural.height),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Paints every photographic area grey, so a flyer can go to the cloud without the photo of people in it.
 * Nearby photo tiles are grouped and each group's whole bounding box is covered, plus a two-tile margin,
 * which also hides the flatter parts of the photo (a wall, the sky) that the tile check does not flag.
 * Returns null if the grey would cover over 40% of the image, or anything photographic is still left:
 * then the image stays on the device.
 */
function redact(src: HTMLCanvasElement, regions: [number, number][], tile = 16): HTMLCanvasElement | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const todo = new Set(regions.map(([x, y]) => key(x, y)));
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = '#9aa0a6';
  for (const [sx, sy] of regions) {
    if (!todo.delete(key(sx, sy))) continue;
    let [x0, y0, x1, y1] = [sx, sy, sx, sy];
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const k = key(x + dx * tile, y + dy * tile);
        if (todo.delete(k)) stack.push([x + dx * tile, y + dy * tile]);
      }
    }
    // Two tiles of margin: the smooth edge of a photo (sky, a wall) can be two tiles wide and is not flagged.
    ctx.fillRect(x0 - 2 * tile, y0 - 2 * tile, x1 - x0 + 5 * tile, y1 - y0 + 5 * tile);
  }
  const pixels = ctx.getImageData(0, 0, out.width, out.height).data;
  // If the grey covers much of the image, it was a photo, not a flyer with a photo in it: keep it local.
  let grey = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 154 && pixels[i + 1] === 160 && pixels[i + 2] === 166) grey++;
  if (grey / (out.width * out.height) > 0.4) return null;
  return photoRegions(pixels, out.width, out.height).length ? null : out;
}

// ---------- cloud queue ----------

// Cloud calls run alongside Gemini Nano instead of blocking it, three at a time to stay inside rate limits.
const CLOUD_SLOTS = 3;
let cloudActive = 0;
const cloudWaiting: (() => void)[] = [];

async function cloudSlot<T>(job: () => Promise<T>): Promise<T> {
  if (cloudActive < CLOUD_SLOTS) cloudActive++;
  else await new Promise<void>((resolve) => cloudWaiting.push(resolve)); // the slot is handed over, count unchanged
  try {
    return await job();
  } finally {
    const next = cloudWaiting.shift();
    if (next) next();
    else cloudActive--;
  }
}

// ---------- scan ----------

async function scan() {
  if (busy) return;
  busy = true;
  $('#scan').setAttribute('disabled', '');
  $('#error').textContent = '';
  $('#stale').hidden = true;
  const started = performance.now();
  scanMs = 0;
  try {
    // initializeDeviceModel must run inside the click, before the first prompt.
    await refreshDevice();
    if (availability === 'downloadable' || availability === 'downloading') startDownload();

    const [tab] = testTarget
      ? (await chrome.tabs.query({})).filter((t) => t.url?.includes(testTarget) && !t.url.startsWith(location.origin))
      : await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:|^file:/.test(tab.url ?? '')) throw new Error('Open a web page first, then scan.');
    tabId = tab.id;
    await inPage(clearMarks, []);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectFromPage });
    if (!result) throw new Error('Could not read this page.');
    page = { title: result.title, url: result.url };
    pdfs = result.pdfs.map((link) => ({ link, status: 'queued' }));

    items = result.images.map((img): Item => {
      const grade = gradeAlt(img.alt);
      const decorative = ruleDecorative(img);
      const base = { img, grade, sources: [], ms: {} };
      // A decorative image with no alt attribute still fails WCAG: screen readers read the file name.
      // The fix is alt="", which needs no AI.
      if (decorative && img.alt === null && !img.hidden && !img.ariaHidden) {
        return { ...base, status: 'review', note: `${decorative}: add an empty alt so screen readers skip it`, kind: 'decorative', suggestion: '' };
      }
      if (decorative) return { ...base, status: 'skipped', note: decorative };
      if (!needsAI(img, grade)) return { ...base, status: 'fine', note: GRADE_LABEL[grade] };
      return { ...base, status: 'queued', note: '' };
    });
    filter = 'todo';
    $('#empty').hidden = true;
    render();
    for (const i of items.filter((i) => i.status === 'review')) await inPage(markOnPage, [i.img.id, 'Rules: alt=""', 'rules', false]);

    const waiting = items.filter((i) => i.status === 'queued');
    const queue = waiting.slice(0, settings.max_images);
    for (const extra of waiting.slice(settings.max_images)) {
      extra.status = 'error';
      extra.note = `Not checked: this scan stops at ${settings.max_images} images`;
    }
    if (queue.length && !(await mayUseCloud())) {
      for (const i of queue) {
        i.status = 'error';
        i.note = 'Not checked: Gemini Nano is not ready and the cloud was declined';
      }
      queue.length = 0;
    }

    // PDFs are cloud work, so they start now and run while Gemini Nano reads the images.
    let pdfsDone = 0;
    const pdfJobs = pdfs.map((p) => cloudSlot(() => processPdf(p)).then(() => { pdfsDone++; render(); }));
    const cloudJobs: Promise<void>[] = [];
    for (const [n, item] of queue.entries()) {
      setProgress(`Reading image ${n + 1} of ${queue.length}${cloudActive ? ' · cloud working alongside' : ''}`, n / (queue.length + 1));
      const { cloud } = await processItem(item);
      if (cloud) cloudJobs.push(cloud);
      render();
    }
    if (cloudJobs.length || pdfsDone < pdfs.length) {
      setProgress('Waiting for the cloud to finish', queue.length / (queue.length + 1));
      await Promise.all([...cloudJobs, ...pdfJobs]);
    }
    scanMs = performance.now() - started;
    setProgress(queue.length || pdfs.length ? `Done in ${secs(scanMs)}. ${queue.length} images and ${pdfs.length} PDFs checked.` : 'Nothing to fix on this page.', 1);
    render();
  } catch (e) {
    $('#error').textContent = e instanceof Error ? e.message : String(e);
    setProgress('', 0);
  } finally {
    busy = false;
    $('#scan').removeAttribute('disabled');
    if (items.length) render(); // the timing line only shows once the scan is over
  }
}

async function inPage(func: (...a: never[]) => void, args: unknown[]) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: func as () => void, args: args as [] });
  } catch {
    // the tab navigated away; the panel keeps working
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

function routeLabel(item: Item): { text: string; tone: 'device' | 'cloud' } {
  const cloud = item.sources.includes('in_cloud');
  const where = cloud ? (item.cloudView ? 'Photo blanked → Cloud' : item.sources.includes('on_device') ? 'Nano → Cloud' : 'Cloud') : 'On device';
  return { text: `${where} · ${KIND_LABEL[item.kind!]}`, tone: cloud ? 'cloud' : 'device' };
}

async function finish(item: Item) {
  item.status = 'review';
  const { text, tone } = routeLabel(item);
  await inPage(markOnPage, [item.img.id, text, tone, false]);
}

async function fail(item: Item, e: unknown) {
  item.status = 'error';
  item.note = errorText(e);
  await inPage(markOnPage, [item.img.id, 'Not checked', 'rules', false]);
}

/**
 * Gemini Nano classifies the image. If it needs the cloud, Nano answers a second question first:
 * is there a person anywhere in it? Only a clear "no" lets the image leave the device.
 * The cloud part is returned as a promise so Nano can move on to the next image meanwhile.
 */
async function processItem(item: Item): Promise<{ cloud?: Promise<void> }> {
  item.status = 'working';
  item.sources = [];
  item.ms = {};
  render();
  await inPage(markOnPage, [item.img.id, 'Reading…', 'working', true]);
  try {
    const { part, natural, thumb, regions } = await loadImage(item.img.src).catch(() => {
      throw new Error('Could not load this image');
    });
    const hasPhoto = regions.length > 0;
    item.thumb = thumb;
    item.cloudView = undefined;
    let t = performance.now();
    const c = await classify(item.img, part, page.title, strict);
    item.ms[c.source === 'on_device' ? 'device' : 'cloud'] = performance.now() - t;
    item.sources.push(c.source);
    item.kind = c.kind;
    // Stick figures and icons in a drawing are not a photo of anyone.
    item.hasPeople = c.has_people && hasPhoto;
    item.suggestion = c.kind === 'decorative' ? '' : tidyAlt(c.alt);
    item.note = item.hasPeople
      ? (c.source === 'on_device' ? 'People in photo: kept on this device' : 'People in photo, read in the cloud because Gemini Nano is not ready')
      : '';

    if (wantsCloud(c, settings.escalate_text_images)) {
      let send = natural;
      let why = hasPhoto ? 'Read in the cloud because Gemini Nano is not ready' : 'A drawing, no photo of anyone';
      let photoSeen = '';
      if (hasPhoto && c.source === 'on_device') {
        let people = c.has_people;
        if (!people) {
          // The first look may miss a small face. Fail closed: if this check breaks, assume a person.
          t = performance.now();
          people = await hasPeopleOnDevice(part).catch(() => true);
          item.ms.device = (item.ms.device ?? 0) + performance.now() - t;
          why = 'Gemini Nano checked twice: no people';
        }
        if (people) {
          item.hasPeople = true;
          const blanked = redactable(regions.length, natural.width, natural.height) ? redact(natural, regions) : null;
          if (!blanked) {
            if (!c.has_people) item.note = 'Gemini Nano may have seen a person, so this stays on the device to be safe';
            // Gemini Nano reads small text less reliably than the cloud. Say so instead of hiding it.
            if (c.has_text && !c.has_people) item.note += '. Check that the alt includes the dates, times and prices shown in the image.';
            await finish(item);
            return {};
          }
          send = blanked;
          photoSeen = item.suggestion ?? '';
          why = 'Photo of people blanked out on this device';
          item.cloudView = toCanvasFrom(blanked, 320).toDataURL('image/jpeg', 0.8);
        }
      }
      item.note = `${why}. Sent to the cloud ${c.kind === 'complex' ? 'for a full description' : 'to read the text'}.`;
      render();
      await inPage(markOnPage, [item.img.id, 'Sending to cloud…', 'working', false]);
      const cloudPart = jpeg(send);
      const cloud = cloudSlot(async () => {
        const t2 = performance.now();
        const d = await describe(item.img, cloudPart, page.title, photoSeen);
        item.ms.cloud = (item.ms.cloud ?? 0) + performance.now() - t2;
        item.sources.push(d.source);
        item.suggestion = tidyAlt(d.alt);
        item.longDescription = d.long_description.trim();
        await finish(item);
      }).catch((e) => fail(item, e)).finally(render);
      return { cloud };
    }
    await finish(item);
  } catch (e) {
    await fail(item, e);
  }
  return {};
}

const toBase64 = (buf: ArrayBuffer) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(new Blob([buf]));
});

/** Structure checks run locally on the bytes; the content review needs the cloud (PDF input is cloud only). */
async function processPdf(p: PdfItem) {
  p.status = 'working';
  render();
  try {
    const res = await fetch(p.link.href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    p.sizeKb = Math.round(buf.byteLength / 1024);
    p.facts = await pdfFacts(buf);
    if (buf.byteLength > settings.pdf_max_mb * 1024 * 1024) {
      p.note = `Larger than ${settings.pdf_max_mb} MB, so only the structure was checked`;
    } else {
      p.review = await reviewPdf(await toBase64(buf), p.link.text, page.title);
    }
    p.status = 'done';
  } catch (e) {
    p.status = 'error';
    p.note = errorText(e);
  }
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ONLY_ON_DEVICE|LanguageModel API not available|on-device model is not available/i.test(m)) return 'Not checked: strict privacy is on and Gemini Nano is not ready';
  if (/\b(429|500|502|503|504)\b|overloaded|unavailable|RESOURCE_EXHAUSTED|Failed to fetch|network/i.test(m)) return 'The cloud model was busy. Try again in a minute.';
  return m.replace(/^\[?FirebaseError[^\]]*\]?:?\s*/i, '').slice(0, 140);
}

function setProgress(text: string, fraction: number) {
  $('#progress-text').textContent = text;
  $('#progress-bar').style.width = `${Math.round(fraction * 100)}%`;
}

// ---------- scoring and counters ----------

const OK_NOW: Status[] = ['skipped', 'fine'];
const OK_AFTER: Status[] = ['skipped', 'fine', 'accepted', 'review']; // review = a suggestion is ready

function score(list: Item[], after: boolean): number {
  if (!list.length) return 100;
  const ok = list.filter((i) => (after ? OK_AFTER : OK_NOW).includes(i.status)).length;
  return Math.round((ok / list.length) * 100);
}

// ---------- listen: what a screen reader says now, and after the fix ----------

function heard(i: Item, after: boolean): string {
  const link = i.img.linkHref ? 'link, ' : '';
  const alt = after ? i.suggestion ?? '' : i.img.alt;
  if (alt === null) {
    const file = decodeURIComponent(i.img.src.startsWith('data:') ? 'image' : i.img.src.split(/[?#]/)[0].split('/').pop() || 'image');
    return `${link}${file}, image`;
  }
  return alt.trim() ? `${link}${alt}, image` : 'nothing at all. The screen reader skips this image.';
}

function listen(i: Item) {
  speechSynthesis.cancel();
  for (const text of [`Right now, a screen reader says: ${heard(i, false)}`, `With Altwise: ${heard(i, true)}`]) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  }
}

// ---------- render ----------

function render() {
  const total = items.length;
  $('#summary').hidden = total === 0;
  $('#tabs').hidden = total === 0;
  save();
  if (!total) return;

  // Three tiers: rules only (no AI), Gemini Nano on this device, Gemini in the cloud.
  const cloud = items.filter((i) => i.sources.includes('in_cloud')).length;
  const device = items.filter((i) => i.sources.includes('on_device') && !i.sources.includes('in_cloud')).length;
  const rules = total - cloud - device;
  $('#page-title').textContent = page.title || page.url;
  $('#score-before').textContent = String(score(items, false));
  $('#score-after').textContent = String(score(items, true));
  $('#count-rules').textContent = String(rules);
  $('#count-local').textContent = String(device);
  $('#count-cloud').textContent = String(cloud);
  $('#meter-rules').style.flexGrow = String(rules);
  $('#meter-local').style.flexGrow = String(device);
  $('#meter-cloud').style.flexGrow = String(cloud);
  // The number that matters for privacy: photos of people that reached the cloud (only possible in the
  // cloud fallback the person agreed to). Blanked-out flyers went without the photo.
  const peopleOut = items.filter((i) => i.hasPeople && i.sources.includes('in_cloud') && !i.cloudView).length;
  const blanked = items.filter((i) => i.cloudView).length;
  $('#privacy-line').textContent = peopleOut
    ? `${peopleOut} photo${peopleOut > 1 ? 's' : ''} of people went to the cloud because Gemini Nano was not ready.`
    : `No photo of a person was sent to the cloud${blanked ? `. ${blanked} flyer${blanked > 1 ? 's' : ''} went with the photo painted grey` : ''}.`;
  $('#privacy-line').dataset.state = peopleOut ? 'warn' : 'ok';
  $('#local-line').textContent = `${total - cloud} of ${total} images never left this device.`;
  const nano = items.filter((i) => i.ms.device);
  $('#timing').textContent = nano.length && !busy
    ? `Gemini Nano took ${secs(nano.reduce((s, i) => s + i.ms.device!, 0) / nano.length)} an image on average.${scanMs ? ` Whole scan: ${secs(scanMs)}, with the cloud working in parallel.` : ''}`
    : '';

  const todo = items.filter((i) => !['skipped', 'fine', 'accepted'].includes(i.status));
  $('#tab-todo').textContent = `To fix (${todo.length})`;
  $('#tab-all').textContent = `All (${total})`;
  $('#tab-pdf').textContent = `PDFs (${pdfs.length})`;
  $('#tab-pdf').hidden = pdfs.length === 0;
  for (const t of ['todo', 'all', 'pdf'] as const) $(`#tab-${t}`).ariaPressed = String(filter === t);
  $('#list').hidden = filter === 'pdf';
  $('#pdfs').hidden = filter !== 'pdf';
  const reviewable = items.filter((i) => i.status === 'review').length;
  $('#accept-all').textContent = reviewable ? `Accept all ${reviewable}` : 'Accept all';
  $('#accept-all').toggleAttribute('disabled', !reviewable);

  // Re-rendering replaces the cards, so put focus and the text cursor back where they were.
  const active = document.activeElement as HTMLElement | null;
  const focusId = active?.id;
  const cursor = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;

  const shown = filter === 'todo' ? todo : items;
  $('#list').innerHTML = shown.length ? shown.map(card).join('') : `<p class="empty">Everything on this list is fixed.</p>`;
  renderPdfs();

  const again = focusId ? document.getElementById(focusId) : null;
  if (again && again !== active) {
    again.focus();
    if (cursor && again instanceof HTMLTextAreaElement) again.setSelectionRange(cursor[0], cursor[1]);
  }
}

const KIND_LABEL: Record<Kind, string> = { decorative: 'Decorative', informative: 'Informative', functional: 'Link or button', complex: 'Chart or diagram' };

function badges(i: Item): string {
  return [...new Set(i.sources)]
    .map((s) => s === 'on_device'
      ? `<span class="badge device" title="Processed by Gemini Nano on this computer">On device${i.ms.device ? ` · ${secs(i.ms.device)}` : ''}</span>`
      : `<span class="badge cloud" title="Processed by Gemini in the cloud">Cloud${i.ms.cloud ? ` · ${secs(i.ms.cloud)}` : ''}</span>`)
    .join('');
}

function card(i: Item): string {
  const id = i.img.id;
  const current = i.img.alt === null ? '<em>none</em>' : i.img.alt === '' ? '<em>empty</em>' : esc(i.img.alt);
  const thumb = `<img class="thumb" src="${esc(i.thumb ?? i.img.src)}" alt="">`;
  const btn = (act: string, label: string, primary = false) =>
    `<button id="${act}-${id}" ${primary ? 'class="primary" ' : ''}data-act="${act}" data-id="${id}" aria-describedby="h-${id}">${label}</button>`;
  const head = `<h3 class="sr" id="h-${id}">Image ${id + 1}, ${GRADE_LABEL[i.grade]}</h3>
    <div class="card-head">${thumb}<div class="meta">
      <div class="chips"><span class="chip grade-${i.grade}">${GRADE_LABEL[i.grade]}</span>${i.kind ? `<span class="chip">${KIND_LABEL[i.kind]}</span>` : ''}${badges(i)}</div>
      <div class="current">Current alt: ${current}</div>
      ${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}
    </div></div>`;

  let body = '';
  if (i.status === 'queued') body = `<div class="state">Waiting</div>`;
  else if (i.status === 'working') body = `<div class="state working">${i.sources.length ? 'Cloud is writing a full description…' : 'Reading image…'}</div>`;
  else if (i.status === 'review' || i.status === 'accepted') {
    body = `<label class="field-label" for="alt-${id}">Suggested alt text${i.kind === 'decorative' ? ' (empty, decorative)' : ''}</label>
      <textarea id="alt-${id}" data-id="${id}" rows="2" maxlength="250">${esc(i.suggestion ?? '')}</textarea>
      ${i.longDescription ? `<details><summary>Long description</summary><p>${esc(i.longDescription)}</p></details>` : ''}
      ${i.cloudView ? `<details><summary>What the cloud saw</summary><img class="cloud-view" src="${i.cloudView}" alt="The image as sent to the cloud, with the photo of people painted grey"></details>` : ''}
      <div class="actions">
        ${i.status === 'accepted' ? `<span class="done">Accepted</span>` : btn('accept', 'Accept', true)}
        ${btn('listen', 'Listen')}
        ${btn('show', 'Show on page')}
        ${btn('copy', 'Copy HTML')}
      </div>`;
  } else if (i.status === 'error') body = `<div class="actions">${btn('retry', 'Try again')}${btn('show', 'Show on page')}</div>`;
  else body = `<div class="actions">${btn('show', 'Show on page')}</div>`;

  return `<article id="card-${id}" class="card status-${i.status}" aria-labelledby="h-${id}">${head}${body}</article>`;
}

function pdfChecks(p: PdfItem): [string, boolean][] {
  const f = p.facts!;
  return [
    ['Real text, not a scanned image', f.hasText && !p.review?.scanned],
    ['Tagged for screen readers', f.tagged],
    ['Has a descriptive title', f.title],
    ['Language is set', f.lang],
    ['Link text names the document', !vagueLinkText(p.link.text)],
  ];
}

const pdfPasses = (p: PdfItem) => p.status === 'done' && pdfChecks(p).every(([, ok]) => ok);

function pdfCard(p: PdfItem, n: number): string {
  const name = p.link.text || p.link.href.split('/').pop() || p.link.href;
  const head = `<div class="pdf-head"><a href="${esc(p.link.href)}" target="_blank" rel="noopener">${esc(name)}<span class="sr"> (opens in a new tab)</span></a>
    ${p.review ? '<span class="badge cloud" title="Read by Gemini in the cloud. PDF input is cloud only.">Cloud</span>' : ''}
    ${p.sizeKb ? `<span class="size">${p.sizeKb} KB</span>` : ''}</div>`;
  if (p.status === 'queued') return `<article class="card">${head}<div class="state">Waiting</div></article>`;
  if (p.status === 'working') return `<article class="card">${head}<div class="state working">Reading PDF…</div></article>`;
  if (p.status === 'error') return `<article class="card">${head}<div class="note">${esc(p.note ?? '')}</div></article>`;

  const checks = pdfChecks(p).map(([label, ok]) =>
    `<li class="${ok ? 'pass' : 'fail'}"><span aria-hidden="true">${ok ? '✓' : '✕'}</span> ${label}<span class="sr"> ${ok ? 'passes' : 'needs a fix'}</span></li>`).join('');
  const r = p.review;
  const review = r ? `
    <p class="summary">${esc(r.summary)}</p>
    ${r.issues.length ? `<details><summary>${r.issues.length} problem${r.issues.length > 1 ? 's' : ''} inside the document</summary><ul>${r.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}
    <label class="field-label" for="pdf-link-${n}">Suggested link text</label>
    <textarea id="pdf-link-${n}" data-pdf="${n}" rows="1">${esc(r.link_text)}</textarea>
    <div class="note">Suggested title: ${esc(r.title)}</div>
    <div class="actions"><button id="copy-pdf-${n}" data-act="copy-pdf" data-pdf="${n}">Copy link HTML</button></div>` : p.note ? `<div class="note">${esc(p.note)}</div>` : '';
  return `<article class="card">${head}<ul class="checks">${checks}</ul>${review}</article>`;
}

function renderPdfs() {
  const done = pdfs.filter((p) => p.status === 'done');
  $('#pdf-count').textContent = done.length ? `${pdfs.filter(pdfPasses).length} of ${pdfs.length} pass` : String(pdfs.length);
  $('#pdf-list').innerHTML = pdfs.map(pdfCard).join('');
}

function pdfLinkHtml(p: PdfItem): string {
  return `<a href="${esc(p.link.href)}">${esc(p.review?.link_text ?? p.link.text)}${p.sizeKb ? `, ${p.sizeKb} KB` : ''}</a>`;
}

// ---------- keep results when the panel closes ----------

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => chrome.storage.session.set({ last: { items, pdfs, page, tabId, scanMs } }).catch(() => {}), 400);
}

async function restore() {
  const { last } = await chrome.storage.session.get('last') as { last?: { items: Item[]; pdfs: PdfItem[]; page: typeof page; tabId: number; scanMs: number } };
  if (!last?.items?.length || items.length) return;
  ({ items, pdfs, page, tabId, scanMs } = last);
  for (const i of items) {
    if (i.status === 'queued' || i.status === 'working') { i.status = 'error'; i.note = 'Not finished: the panel was closed during the scan'; }
  }
  for (const p of pdfs) {
    if (p.status === 'queued' || p.status === 'working') { p.status = 'error'; p.note = 'Not finished: the panel was closed during the scan'; }
  }
  $('#empty').hidden = true;
  render();
  checkStale();
}

/** The results belong to one page. Say so when the person moves to another one. */
async function checkStale() {
  if (!items.length || busy || testTarget) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#stale').hidden = !tab?.url || tab.url === page.url;
}

// ---------- export ----------

function htmlFor(i: Item): string {
  const alt = esc(i.suggestion ?? '');
  const src = esc(i.img.src);
  if (!i.longDescription) return `<img src="${src}" alt="${alt}">`;
  const did = `desc-${i.img.id}`;
  return `<figure>\n  <img src="${src}" alt="${alt}" aria-describedby="${did}">\n  <details id="${did}">\n    <summary>Description of this image</summary>\n    <p>${esc(i.longDescription)}</p>\n  </details>\n</figure>`;
}

function csv(): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [['page', 'image', 'current_alt', 'issue', 'type', 'suggested_alt', 'long_description', 'processed', 'status']];
  for (const i of items) {
    rows.push([page.url, i.img.src, i.img.alt ?? '', GRADE_LABEL[i.grade], i.kind ?? '', i.suggestion ?? '', i.longDescription ?? '',
      [...new Set(i.sources)].join('+') || 'rules only', i.status]);
  }
  for (const p of pdfs) {
    const failed = p.facts ? pdfChecks(p).filter(([, ok]) => !ok).map(([l]) => l).join('; ') : p.note ?? '';
    rows.push([page.url, p.link.href, p.link.text, failed, 'pdf', p.review?.link_text ?? '', [p.review?.summary, ...(p.review?.issues ?? [])].filter(Boolean).join(' '),
      p.review ? 'in_cloud' : 'rules only', p.status]);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function flash(btn: HTMLElement, text: string) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

async function accept(item: Item) {
  item.status = 'accepted';
  await inPage(applyAltOnPage, [item.img.id, item.suggestion ?? '']);
}

// ---------- events ----------

$('#scan').addEventListener('click', scan);
for (const t of ['todo', 'all', 'pdf'] as const) $(`#tab-${t}`).addEventListener('click', () => { filter = t; render(); });
$('#accept-all').addEventListener('click', async () => {
  for (const i of items.filter((i) => i.status === 'review')) await accept(i);
  render();
  $('#copy-all').focus();
});
$('#export-csv').addEventListener('click', () => download(`altwise-${new URL(page.url).hostname}.csv`, csv(), 'text/csv'));
$('#copy-all').addEventListener('click', async (e) => {
  const done = items.filter((i) => i.status === 'accepted');
  await navigator.clipboard.writeText(done.map(htmlFor).join('\n\n'));
  flash(e.currentTarget as HTMLElement, done.length ? `Copied ${done.length}` : 'Accept some first');
});

$('#strict').addEventListener('change', (e) => {
  strict = (e.target as HTMLInputElement).checked;
  chrome.storage.local.set({ strict });
});

$('#pdf-list').addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  const p = pdfs[Number(t.dataset.pdf)];
  if (p?.review) { p.review.link_text = t.value; save(); }
});

$('#pdf-list').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  const p = btn && pdfs[Number(btn.dataset.pdf)];
  if (!btn || !p) return;
  await navigator.clipboard.writeText(pdfLinkHtml(p));
  flash(btn, 'Copied');
});

$('#list').addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  const item = items.find((i) => i.img.id === Number(t.dataset.id));
  if (item) { item.suggestion = t.value; save(); }
});

$('#list').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const item = items.find((i) => i.img.id === Number(btn.dataset.id));
  if (!item) return;
  switch (btn.dataset.act) {
    case 'show': await inPage(highlightOnPage, [item.img.id]); break;
    case 'listen': listen(item); break;
    case 'copy': await navigator.clipboard.writeText(htmlFor(item)); flash(btn, 'Copied'); break;
    case 'accept': {
      // In "To fix" the card disappears, so move focus to the next card instead of losing it.
      const next = btn.closest('article')?.nextElementSibling?.id;
      await accept(item);
      render();
      const target = document.querySelector<HTMLElement>(`#${next} textarea, #${next} button`) ?? document.getElementById(`listen-${item.img.id}`) ?? $('#copy-all');
      target.focus();
      break;
    }
    case 'retry': {
      if (busy || !(await mayUseCloud())) return;
      busy = true;
      const { cloud } = await processItem(item);
      await cloud;
      busy = false;
      render();
      break;
    }
  }
});

chrome.tabs.onActivated.addListener(() => { checkStale(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === 'complete') checkStale(); });

chrome.storage.local.get('strict').then((v) => {
  strict = Boolean(v.strict);
  ($('#strict') as HTMLInputElement).checked = strict;
});
refreshDevice();
loadSettings();
restore();
