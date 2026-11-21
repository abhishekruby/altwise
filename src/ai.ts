// All AI calls go through Firebase AI Logic. The classifier is hybrid; the describer and PDF review are cloud only.
// Remote Config can change the cloud model and routing without shipping a new extension.

import { initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel, type Part } from 'firebase/ai';
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config';
import type { Classification, PageImage } from './rules.ts';

const env = import.meta.env;
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

// The public web version (try.html) uses reCAPTCHA (Google Cloud Fraud Defense) like any website and
// ships no debug token.
// Extensions cannot load reCAPTCHA (remote code is blocked in MV3), so the extension, and local
// development, run App Check in debug mode. With a debug token set, the SDK never calls the provider.
const recaptchaKey = env.MODE === 'web' && !env.DEV ? env.VITE_RECAPTCHA_SITE_KEY : '';
if (!recaptchaKey) {
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN;
}
initializeAppCheck(app, {
  provider: recaptchaKey
    ? new ReCaptchaEnterpriseProvider(recaptchaKey)
    : new CustomProvider({ getToken: () => Promise.reject(new Error('Debug provider only')) }),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app, { backend: new GoogleAIBackend() });

// ---------- Remote Config ----------

const DEFAULTS = {
  cloud_model: 'gemini-3.5-flash-lite',
  max_images: 40,
  escalate_text_images: true,
  pdf_max_mb: 15,
};
export const settings = { ...DEFAULTS };

const rc = getRemoteConfig(app);
rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
rc.defaultConfig = DEFAULTS;

/** Fetches Remote Config once per panel load. Falls back to defaults offline. */
export async function loadSettings(): Promise<void> {
  try {
    await fetchAndActivate(rc);
  } catch {
    // offline or blocked: keep defaults
  }
  settings.cloud_model = getValue(rc, 'cloud_model').asString() || DEFAULTS.cloud_model;
  settings.max_images = getValue(rc, 'max_images').asNumber() || DEFAULTS.max_images;
  settings.escalate_text_images = getValue(rc, 'escalate_text_images').asBoolean();
  settings.pdf_max_mb = getValue(rc, 'pdf_max_mb').asNumber() || DEFAULTS.pdf_max_mb;
  built = null;
}

// ---------- models ----------

const KINDS = ['decorative', 'informative', 'functional', 'complex'];
const classifySchema = (onDevice: boolean) => ({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    has_people: { type: 'boolean' },
    has_text: { type: 'boolean' },
    // The on-device model ignores "under 125 characters" in prose, so enforce it in the schema.
    alt: onDevice ? { type: 'string', maxLength: 125 } : { type: 'string' },
  },
  required: ['kind', 'has_people', 'has_text', 'alt'],
  additionalProperties: false,
});

const json = (schema: Record<string, unknown>) => ({ responseMimeType: 'application/json', responseJsonSchema: schema });

function classifier(cloudModel: string, strictPrivacy: boolean): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: strictPrivacy ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: classifySchema(true) },
    },
    inCloudParams: { model: cloudModel, generationConfig: json(classifySchema(false)) },
  });
}

function cloudOnly(cloudModel: string, schema: Record<string, unknown>): GenerativeModel {
  return getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: cloudModel, generationConfig: json(schema) } });
}

// The privacy gate: a second, narrow question that only Gemini Nano may answer.
const peopleSchema = {
  type: 'object',
  properties: { people: { type: 'boolean' } },
  required: ['people'],
  additionalProperties: false,
};

function build(m: string) {
  return {
    normal: classifier(m, false),
    strict: classifier(m, true),
    gate: getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: { expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] },
        promptOptions: { responseConstraint: peopleSchema },
      },
    }),
    describer: cloudOnly(m, {
      type: 'object',
      properties: { alt: { type: 'string' }, long_description: { type: 'string' } },
      required: ['alt', 'long_description'],
    }),
    pdf: cloudOnly(m, {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        scanned: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
        link_text: { type: 'string' },
      },
      required: ['title', 'summary', 'scanned', 'issues', 'link_text'],
    }),
  };
}

let built: ReturnType<typeof build> | null = null;
const models = () => (built ??= build(settings.cloud_model));

export type Source = 'on_device' | 'in_cloud';

/** Must be called from a click handler. Starts the Gemini Nano download if needed. */
export function initDevice(onProgress: (fraction: number) => void): Promise<void> {
  return models().normal.initializeDeviceModel(onProgress);
}

export async function deviceAvailability(): Promise<string> {
  const lm = (self as unknown as { LanguageModel?: { availability(o: object): Promise<string> } }).LanguageModel;
  if (!lm) return 'unsupported';
  return lm.availability({ expectedInputs: [{ type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
}

// ---------- prompts ----------

// On a slow CPU Gemini Nano takes up to a minute per image, and very rarely it never answers.
// A hung call must not stall the whole scan; the next call opens a fresh session.
const TIME_LIMIT_MS = 150_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer = 0;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('The model took too long to answer')), TIME_LIMIT_MS); }),
  ]);
}

// Busy or rate-limited cloud, or a dropped connection: worth one more try after a short wait.
const transient = (e: unknown) => /\b(429|500|502|503|504)\b|overloaded|unavailable|RESOURCE_EXHAUSTED|Failed to fetch|network/i.test(String(e));

/**
 * Runs a prompt and parses its JSON. Small models sometimes return broken JSON (one more try), and the
 * cloud's free tier has per-minute limits, so a busy answer is retried with growing waits (3, 12, 30 s),
 * enough for a minute's quota to reset. A timeout is not retried.
 */
const BUSY_WAITS = [3000, 12000, 30000];
async function askJson<T>(model: GenerativeModel, request: (string | Part)[]): Promise<{ data: T; source: Source }> {
  let busy = 0, broken = 0;
  for (;;) {
    let result;
    try {
      result = await withTimeout(model.generateContent(request));
    } catch (e) {
      if (busy >= BUSY_WAITS.length || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, BUSY_WAITS[busy++]));
      continue;
    }
    try {
      return { data: JSON.parse(result.response.text()) as T, source: (result.response.inferenceSource ?? 'in_cloud') as Source };
    } catch {
      if (broken++ > 0) throw new Error('The model returned unreadable output');
    }
  }
}

function context(img: PageImage, pageTitle: string): string {
  const lines = [`Page title: ${pageTitle}`];
  if (img.heading) lines.push(`Section heading: ${img.heading}`);
  if (img.caption) lines.push(`Caption: ${img.caption}`);
  if (img.linkHome) lines.push(`The image is a link to this site's home page${img.linkText ? ` (link text: "${img.linkText}")` : ''}`);
  else if (img.linkHref) lines.push(`The image is a link to: ${img.linkHref}${img.linkText ? ` (link text: "${img.linkText}")` : ''}`);
  if (img.nearbyText) lines.push(`Text near the image: ${img.nearbyText}`);
  return lines.join('\n');
}

export async function classify(img: PageImage, part: Part, pageTitle: string, strictPrivacy: boolean) {
  const prompt = `You review images on a school or local government web page for accessibility.
${context(img, pageTitle)}

Classify the image:
- decorative: adds nothing a reader would miss (borders, dividers, background textures, stock mood images that repeat nearby text)
- informative: a photo or illustration that carries meaning
- functional: the image is a link or button; the alt text must say where it goes or what it does. A logo that links to the home page gets the name written in the logo followed by "home", for example "Riverside Library home".
- complex: a chart, graph, map, diagram, infographic or table that needs a long description
Set has_people to true if any person or face is visible. Set has_text to true if the image contains words or numbers a reader needs.
Write alt text for a screen reader user: one short sentence of at most 15 words, specific, no "image of", no colours or clothing unless they matter. Use the page context to understand the image, but describe the image itself and do not copy page text into the alt. For decorative images the alt is "".`;
  const m = models();
  const { data, source } = await askJson<Classification>(strictPrivacy ? m.strict : m.normal, [prompt, part]);
  return { ...data, source };
}

/**
 * Asked on device right before an image would go to the cloud. The first pass may miss a small face
 * in a poster or a crowd in the corner of a map, and a miss would send that photo to the cloud.
 */
export async function hasPeopleOnDevice(part: Part): Promise<boolean> {
  const prompt = `Look at the whole image carefully, including small areas, corners and photos placed inside posters or collages.
Is any real person, face, body or part of a person visible in a photograph? Drawings, icons and cartoons do not count.
Answer people: true or false. If you are unsure, answer true.`;
  const { data } = await askJson<{ people: boolean }>(models().gate, [prompt, part]);
  return data.people;
}

export async function describe(img: PageImage, part: Part, pageTitle: string, blankedPhoto = '') {
  const blanked = blankedPhoto ? `
A photo of people in this image was painted grey on the user's device to protect their privacy. Do not describe the grey area.
On the device, that photo was described as: "${blankedPhoto}". Mention it in a few words where it fits.` : '';
  const prompt = `This image is on a public school or local government web page.
${context(img, pageTitle)}${blanked}

Write for a blind reader using a screen reader.
alt: one sentence under 125 characters with the main takeaway, not a list of colors.
long_description: plain-language description of everything the image shows. For charts give the title, axes and every value you can read. For infographics and screenshots give all the text in reading order. Do not guess values you cannot read; say they are unreadable.`;
  const { data, source } = await askJson<{ alt: string; long_description: string }>(models().describer, [prompt, part]);
  return { ...data, source };
}

export interface PdfReview { title: string; summary: string; scanned: boolean; issues: string[]; link_text: string }

export async function reviewPdf(base64: string, linkText: string, pageTitle: string): Promise<PdfReview> {
  const prompt = `This PDF is linked from the web page "${pageTitle}" with the link text "${linkText}".
Review it for people who use screen readers or have low vision.
title: a short, descriptive document title.
summary: two plain sentences on what the document is and who it is for.
scanned: true if the pages look like scanned images rather than real text.
issues: up to 5 specific accessibility problems you can see, such as text that is only an image, form fields with no labels, tables without headers, meaning shown only by color, low contrast, images that need descriptions. Empty if none.
link_text: better link text for the page, naming the document and ending with "(PDF)".`;
  const part: Part = { type: 'inlineData', inlineData: { mimeType: 'application/pdf', data: base64 } };
  return (await askJson<PdfReview>(models().pdf, [prompt, part])).data;
}
