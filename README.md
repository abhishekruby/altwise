# Altwise

Altwise is a Chrome extension for the people who keep school and town websites running. Open it on any page and it finds every image with missing or weak alt text, writes a better version, and checks the PDFs the page links to. You review each suggestion, accept it, and copy the fixed HTML into your CMS.

It uses Firebase AI Logic hybrid inference. Gemini Nano runs on your computer, looks at every image first and decides what the cloud is allowed to see. Photos of people stay on the computer. Charts, maps and posters full of text go to Gemini in the cloud, because reading small numbers needs a bigger model. When a flyer full of text also has a small photo of children in the corner, Altwise paints the photo grey on your computer and sends the cloud only the rest. Linked PDFs go to the cloud too, since PDF input is cloud only.

## Why this exists

A school newsletter page usually has a dozen images: the class photo, a chart of test scores, a map to the parking lot, a flyer someone photographed on their phone. Many of them have no alt text, or alt text like `IMG_2041.JPG`. A blind parent hears the file name and nothing else. This is the second most common accessibility failure on the web: the [WebAIM Million 2026](https://webaim.org/projects/million/) found missing alt text on 53.1% of the top million home pages, about 10.8 images per page.

In the US, the Department of Justice's 2024 ADA Title II rule requires state and local government websites, public schools included, to meet WCAG 2.1 AA. In April 2026 the DOJ moved the first deadline back by a year, so governments serving 50,000 people or more now have until April 26, 2027. The standard did not change. It covers more than 90,000 local governments, 12,546 of them independent school districts ([2022 Census of Governments](https://www.stlouisfed.org/publications/regional-economist/2024/march/local-governments-us-number-type)). The people responsible are usually a front-office secretary or a communications officer, not a developer. They need a tool that tells them what is wrong on the page in front of them and hands them the fix.

Sending every image to a cloud API is the obvious build, and it is the wrong one here. Those pages are full of children's faces. Altwise keeps them on the device.

## How the routing works

Every image goes through three steps, and the side panel shows which one handled it.

| Step | Where it runs | What it does |
|---|---|---|
| Rules | Your browser, no AI | Skips hidden, tiny and spacer images. Grades existing alt text: missing, file name, generic ("chart", "logo"), too long, starts with "image of". |
| Gemini Nano | On device | Classifies the image as decorative, informative, functional (a link) or complex, notes whether people or text are visible, and writes alt text using the page heading, caption, link target and nearby paragraph. |
| Photo check | Your browser, no AI | Before anything leaves the computer, the image is split into 16 px tiles. In drawings (charts, maps, tables, icons) neighbouring pixels are mostly identical. In photographs they almost never are, in colour or black and white. A drawing cannot show a real person, so it may go to the cloud even if Nano thought it saw stick figures. |
| Gemini Nano, second look | On device | Runs when an image that contains a photo is about to go to the cloud. One narrow question: is any person visible anywhere? Unsure counts as yes, and so does a failed check. |
| Blank out the photo | Your browser, no AI | A flyer with people in a small photo (under 40% of the image) gets that photo painted grey, with a margin, on the computer. The result is checked again and only sent if no photographic pixels are left. The card shows exactly what the cloud saw. A photo with a caption stays on the device. |
| Gemini (cloud) | Firebase AI Logic | Only for charts and text-heavy images that passed the checks above. Writes a short alt and a full long description with every value it can read. Runs alongside Nano, so Nano keeps reading the next image meanwhile. |

PDFs get structure checks on the device (tagged, descriptive title, language, real text or a scan, vague link text like "click here"). The content review goes to the cloud, because PDF input is cloud only.

If Gemini Nano is not available yet (it downloads in the background, and some computers cannot run it), `PREFER_ON_DEVICE` would send every image to the cloud, photos of people included. Altwise asks first. Say yes and the scan runs in the cloud, with every card marked that way. Say no and nothing leaves the computer. **Strict privacy** switches the classifier to `ONLY_ON_DEVICE`, so it never falls back and never asks.

The counter at the top shows how many images were handled by rules, by Gemini Nano and by the cloud, and how many never left the computer. The badge on each result comes from the SDK's `inferenceSource`, not from a guess, and shows how long that step took.

## What you can do with the results

- Edit any suggestion, then **Accept** it or **Accept all**. The fix is previewed on the live page and nothing on the real site changes.
- **Listen** reads the image the way a screen reader does today ("IMG_2041.JPG, image") and then with the suggested text. It is the quickest way to show a colleague why this matters.
- **Copy HTML** gives markup to paste into the CMS. Charts come as a `<figure>` with the long description in a `<details>` block linked by `aria-describedby`.
- **Export CSV** lists every image and PDF with its issue, suggestion and where it was processed, for a report to whoever signs off on compliance.
- Results stay when you close the panel, and the panel tells you when you have moved to a different page.

## Firebase products used

- **Firebase AI Logic** (`firebase/ai`): one hybrid model for classification (`PREFER_ON_DEVICE` or `ONLY_ON_DEVICE`, with a JSON schema passed as `responseConstraint` on device and `responseJsonSchema` in the cloud), plus two cloud-only models for long descriptions and PDF review. See [src/ai.ts](src/ai.ts).
- **App Check**: required by AI Logic. Chrome extensions cannot load reCAPTCHA (Manifest V3 blocks remote code), so the extension uses the debug provider, which the hackathon rules allow.
- **Remote Config**: the cloud model name, the image limit per scan, whether text images escalate, and the PDF size limit can change without shipping a new build. The template is in [remote-config.json](remote-config.json).

## Try it

**In your browser, nothing to install: https://altwise.web.app** shows the demo school page beside the real Altwise panel. It is the same panel code as the extension, built as a normal web page (Firebase Hosting, App Check with reCAPTCHA through Google Cloud Fraud Defense). Gemini Nano runs on device wherever Chrome supports the Prompt API on the web; otherwise Altwise asks before using the cloud.

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

**Live demo page: https://abhishekruby.github.io/altwise/demo/** (open it, then click the Altwise icon and scan).

**Privacy test page: https://abhishekruby.github.io/altwise/demo/flyers.html.** Three school flyers hide a small photo of children. Altwise keeps those photos on the device and sends the cloud a copy with the photo painted grey, so the event details still get read. A bus timetable, a chart and a cartoon poster go to the cloud as they are.

[demo/](demo/) is a fictional school newsletter with the usual mistakes on purpose: a file name as alt text, a chart with alt="chart", a map and a pie chart with no alt, a librarian photo marked decorative, a scanned PDF behind a "click here" link. Run `npm run web` to serve it locally.

## Known limits

- Only `<img>` elements are checked. CSS background images, inline `<svg>` and images inside iframes are not.
- One page at a time. There is no site crawl.
- Gemini Nano needs a capable computer (see above). On other computers Altwise still works, using the cloud after you agree to it.

## Development

- `npm test` runs the rule and PDF checks in Node.
- `npm run web` then `http://localhost:5173/try.html` shows the demo page and the real panel side by side, with live reload. [src/web.ts](src/web.ts) stands in for the few `chrome.*` APIs the panel uses. `npm run build:web` builds the public version and fails if the App Check debug token ends up in it.
- `python3 dev/make_assets.py` regenerates the demo PDFs and the icons.

```
src/ai.ts       Firebase init, App Check, Remote Config, the three models and their prompts
src/rules.ts    alt text grading, decorative detection, routing rule
src/pdf.ts      PDF structure checks from raw bytes and Flate streams
src/page.ts     functions injected into the audited tab
src/main.ts     side panel: scan loop, routing, redaction, cards, export
src/web.ts      the same panel as a web page (try.html)
```

## Built during the hackathon

Everything in this repo was written for #BuildHybridAI 2026, starting 17 November 2026. It was built with help from an AI coding assistant (Claude Code). Demo photos are from Unsplash, see [demo/CREDITS.md](demo/CREDITS.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
