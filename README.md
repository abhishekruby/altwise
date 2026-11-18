# Altwise

Altwise is a Chrome extension for the people who keep school and town websites running. Open it on any page and it finds every image with missing or weak alt text, writes a better version, and checks the PDFs the page links to. You review each suggestion, accept it, and copy the fixed HTML into your CMS.

It uses Firebase AI Logic hybrid inference. Gemini Nano runs on your computer and handles most images. Photos of people are never sent anywhere. Only charts, maps, posters full of text and PDFs go to Gemini in the cloud, because those need a bigger model to read small numbers and long documents.

## Why this exists

A school newsletter page usually has a dozen images: the class photo, a chart of test scores, a map to the parking lot, a flyer someone photographed on their phone. Most of them have no alt text, or alt text like `IMG_2041.JPG`. A blind parent hears the file name and nothing else.

In the US, the Department of Justice's 2024 ADA Title II rule requires state and local government websites, public schools included, to meet WCAG 2.1 AA. In April 2026 the DOJ moved the first deadline back by a year, so governments serving 50,000 people or more now have until April 26, 2027. The standard did not change. The people responsible are usually a front-office secretary or a communications officer, not a developer. They need a tool that tells them what is wrong on the page in front of them and hands them the fix.

Sending every image to a cloud API is the obvious build, and it is the wrong one here. Those pages are full of children's faces. Altwise keeps them on the device.

## How the routing works

Every image goes through three steps, and the side panel shows which one handled it.

| Step | Where it runs | What it does |
|---|---|---|
| Rules | Your browser, no AI | Skips hidden, tiny and spacer images. Grades existing alt text: missing, file name, generic ("chart", "logo"), too long, starts with "image of". |
| Gemini Nano | On device | Classifies the image as decorative, informative, functional (a link) or complex, notes whether people or text are visible, and writes alt text using the page heading, caption, link target and nearby paragraph. |
| Gemini (cloud) | Firebase AI Logic | Only for complex images and informative images with text, and only if no people are visible. Writes a short alt and a full long description with every value it can read. |

PDFs get structure checks on the device (tagged, descriptive title, language, real text or a scan, vague link text like "click here"). The content review goes to the cloud, because PDF input is cloud only.

If Gemini Nano is not available yet (it downloads in the background, and some computers cannot run it), `PREFER_ON_DEVICE` falls back to the cloud so the tool still works. The panel says so on every card. Turn on **Strict privacy** to switch to `ONLY_ON_DEVICE`, where nothing is classified in the cloud at all.

The counter at the top shows how many images were handled by rules, by Gemini Nano and by the cloud, and how many never left the computer. The badge on each result comes from the SDK's `inferenceSource`, not from a guess.

## Firebase products used

- **Firebase AI Logic** (`firebase/ai`): one hybrid model for classification (`PREFER_ON_DEVICE` or `ONLY_ON_DEVICE`, with a JSON schema passed as `responseConstraint` on device and `responseJsonSchema` in the cloud), plus two cloud-only models for long descriptions and PDF review. See [src/ai.ts](src/ai.ts).
- **App Check**: required by AI Logic. Chrome extensions cannot load reCAPTCHA (Manifest V3 blocks remote code), so the extension uses the debug provider, which the hackathon rules allow.
- **Remote Config**: the cloud model name, the image limit per scan, whether text images escalate, and the PDF size limit can change without shipping a new build. The template is in [remote-config.json](remote-config.json).

## Try it

### Load the extension

You need Chrome 139 or later on desktop.

1. Clone the repo and install: `npm install`
2. Copy `.env.example` to `.env.local` and fill in a Firebase web app config with AI Logic (Gemini Developer API) and App Check enabled. Register an App Check debug token in the Firebase console and put it in `VITE_APPCHECK_DEBUG_TOKEN`.
3. Build: `npm run build`
4. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose the `dist` folder.
5. Click the Altwise icon in the toolbar to open the side panel, then **Scan this page**.

### Turn on Gemini Nano (optional)

Without this, Altwise uses the cloud for everything and says so. To run on device:

1. In `chrome://flags`, enable **Prompt API for Gemini Nano with Multimodal Input**, then relaunch.
2. Check that your computer meets [Chrome's hardware requirements](https://developer.chrome.com/docs/ai/get-started) (a GPU with more than 4 GB of VRAM, or 16 GB of RAM and 4 CPU cores, plus about 22 GB of free disk).
3. Click **Scan this page** once. That starts the model download, and the status chip in the panel shows progress.

### Demo page

[demo/](demo/) is a fictional school newsletter with the usual mistakes on purpose: a file name as alt text, a chart with alt="chart", a map and a pie chart with no alt, a librarian photo marked decorative, a scanned PDF behind a "click here" link. Serve the repo with `npx vite` and open `http://localhost:5173/demo/`.

## Development

- `npm test` runs the rule and PDF checks in Node.
- `npx vite` then `http://localhost:5173/dev/` shows the demo page and the real panel side by side. Chrome extension APIs are stubbed, so you can work on the panel without reloading the extension.
- `python3 dev/make_assets.py` regenerates the demo PDFs and the icons.

```
src/ai.ts       Firebase init, App Check, Remote Config, the three models and their prompts
src/rules.ts    alt text grading, decorative detection, routing rule
src/pdf.ts      PDF structure checks from raw bytes and Flate streams
src/page.ts     functions injected into the audited tab
src/main.ts     side panel: scan loop, cards, export
```

## Built during the hackathon

Everything in this repo was written for #BuildHybridAI 2026, starting 17 November 2026. It was built with help from an AI coding assistant (Claude Code). Demo photos are from Unsplash, see [demo/CREDITS.md](demo/CREDITS.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
