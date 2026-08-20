# In-Browser PII Masker & Redactor

Production-oriented Chrome Manifest V3 extension that redacts sensitive PII and secrets locally in editable fields before submission.

## Structure

```text
.
|-- manifest.json
|-- package.json
|-- models/
|-- scripts/
|   |-- build.mjs
|   `-- download-model.mjs
`-- src/
    |-- background/service-worker.js
    |-- content/content-script.js
    |-- offscreen/offscreen.html
    |-- offscreen/offscreen.js
    |-- popup/popup.html
    |-- popup/popup.css
    |-- popup/popup.js
    |-- utils/regex-rules.js
    `-- workers/ner-worker.js
```

## Build

```bash
npm install
npm run prepare:model
npm run build
```

Load `dist/` as an unpacked extension in Chrome.

The worker uses the maintained `@huggingface/transformers` package, which is the current package name for Transformers.js. The default model is `Xenova/bert-base-NER`. The model download step is a build-time operation. Runtime inference is configured with `allowRemoteModels = false`, so page data is not sent to any external API or model host.
