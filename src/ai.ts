// All AI calls go through Firebase AI Logic. The classifier is hybrid; the describer is cloud only.

import { initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel, type Part } from 'firebase/ai';
import type { Classification, PageImage } from './rules.ts';

const env = import.meta.env;
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

// Extensions cannot load reCAPTCHA (remote code is blocked in MV3), so App Check runs
// in debug mode. With a debug token set, the SDK never calls the provider below.
(self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN;
initializeAppCheck(app, {
  provider: new CustomProvider({ getToken: () => Promise.reject(new Error('Debug provider only')) }),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app, { backend: new GoogleAIBackend() });
const CLOUD_MODEL = 'gemini-3.5-flash-lite';

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

function classifier(strictPrivacy: boolean): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: strictPrivacy ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: classifySchema(true) },
    },
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: classifySchema(false) },
    },
  });
}

const models = { normal: classifier(false), strict: classifier(true) };

const describer = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_IN_CLOUD,
  inCloudParams: {
    model: CLOUD_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: { alt: { type: 'string' }, long_description: { type: 'string' } },
        required: ['alt', 'long_description'],
      },
    },
  },
});

export type Source = 'on_device' | 'in_cloud';

/** Must be called from a click handler. Starts the Gemini Nano download if needed. */
export function initDevice(onProgress: (fraction: number) => void): Promise<void> {
  return models.normal.initializeDeviceModel(onProgress);
}

export async function deviceAvailability(): Promise<string> {
  const lm = (self as unknown as { LanguageModel?: { availability(o: object): Promise<string> } }).LanguageModel;
  if (!lm) return 'unsupported';
  return lm.availability({ expectedInputs: [{ type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
}

function context(img: PageImage, pageTitle: string): string {
  const lines = [`Page title: ${pageTitle}`];
  if (img.heading) lines.push(`Section heading: ${img.heading}`);
  if (img.caption) lines.push(`Caption: ${img.caption}`);
  if (img.linkHref) lines.push(`The image is a link to: ${img.linkHref}${img.linkText ? ` (link text: "${img.linkText}")` : ''}`);
  if (img.nearbyText) lines.push(`Text near the image: ${img.nearbyText}`);
  return lines.join('\n');
}

export async function classify(img: PageImage, part: Part, pageTitle: string, strictPrivacy: boolean) {
  const prompt = `You review images on a school or local government web page for accessibility.
${context(img, pageTitle)}

Classify the image:
- decorative: adds nothing a reader would miss (borders, dividers, background textures, stock mood images that repeat nearby text)
- informative: a photo or illustration that carries meaning
- functional: the image is a link or button; the alt text must say where it goes or what it does
- complex: a chart, graph, map, diagram, infographic or table that needs a long description
Set has_people to true if any person or face is visible. Set has_text to true if the image contains words or numbers a reader needs.
Write alt text for a screen reader user: specific, under 125 characters, no "image of". Use the page context. For decorative images the alt is "".`;
  const result = await (strictPrivacy ? models.strict : models.normal).generateContent([prompt, part]);
  const parsed = JSON.parse(result.response.text()) as Classification;
  return { ...parsed, source: (result.response.inferenceSource ?? 'in_cloud') as Source };
}

export async function describe(img: PageImage, part: Part, pageTitle: string) {
  const prompt = `This image is on a public school or local government web page.
${context(img, pageTitle)}

Write for a blind reader using a screen reader.
alt: one sentence under 125 characters with the main takeaway, not a list of colors.
long_description: plain-language description of everything the image shows. For charts give the title, axes and every value you can read. For infographics and screenshots give all the text in reading order. Do not guess values you cannot read; say they are unreadable.`;
  const result = await describer.generateContent([prompt, part]);
  return { ...(JSON.parse(result.response.text()) as { alt: string; long_description: string }), source: 'in_cloud' as Source };
}
