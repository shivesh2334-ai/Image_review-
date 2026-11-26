# Imaging Review

A local browser workspace for CT and MRI videos and digitized X-rays. The included teaching case is an illustrated example of a pulmonary arterial filling defect. No source patient video is bundled.

## Start

Install Node.js 20 or later, unzip the folder, and run:

```sh
node server.mjs
```

Open <http://127.0.0.1:4173>. Manual review, the teaching case and optional AI review use the same interface. No package installation is needed.

## Review a study

1. Choose CT, MRI or X-ray and upload a browser-readable video or image. MP4 (H.264), WebM, JPEG and PNG are typical choices. For a physical X-ray film, use a digitized image. Video stepping is approximately 33 ms, and timestamps refer to the uploaded video. Native DICOM, window/level adjustment and calibrated measurements are outside this version.
2. Scrub to the desired frame. For manual annotations, choose a category, type a label and select **Place marker**, then click on the image. Annotation entries jump to the associated frame and can be renamed or removed.
3. For AI suggestions, enter a request or use a preset. Select the current frame or an eight-frame sweep. Confirm de-identification and processing approval before you send. Check each proposed marker against the original study.
4. Use **Save marked frame** for a PNG or **Export review** for the request, last AI response and current annotations in JSON. Export before loading a new study.

## Connect an imaging model

The local server accepts a configured vision endpoint that implements the OpenAI-compatible Chat Completions request format and supports base64 JPEGs. Use a model validated for the imaging task and approved for the data you intend to submit. The endpoint must support HTTPS, or HTTP on loopback. Example configuration for a locally running model service:

```sh
IMAGING_MODEL_URL=http://127.0.0.1:8000/v1/chat/completions \
IMAGING_MODEL=your-imaging-model \
node server.mjs
```

Set `IMAGING_MODEL_KEY` on the server if the provider requires a token. The key stays server-side. The application does not record uploads or model responses on disk. A remote model receives sampled images and request text and may apply its own retention rules. Do not send studies containing identifying information, including burned-in identifiers. The review server binds to loopback and is intended for local use.

### Model response format

Return a JSON object as the assistant message content, for example:

```json
{"summary":"Example observation","limitations":"Only one frame supplied","annotations":[{"frame":0,"label":"Example landmark","kind":"anatomy","x":0.42,"y":0.51}]}
```

Frame indices start at zero. Coordinates are fractions measured from the top-left of the submitted image. Annotation types are `anatomy` and `finding`.

## Clinical scope

AI suggestions are preliminary and require clinician verification. Sampled frames can miss pathology and cannot replace review of the original series and formal radiology interpretation. The bundled case is a schematic for teaching. Model accuracy and coordinate localization require independent validation before any clinical use.

## Vercel

Import the repository root as an Other project. The deployed viewer supports manual review and the PE teaching schematic. AI requests are disabled on the hosted build. Run the local server with an approved imaging model for AI review.
