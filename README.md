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

## Default AI model: MedGemma 1.5 4B (Google, open weights) via vLLM

By default, `server.mjs` targets **`google/medgemma-1.5-4b-it`** at `http://127.0.0.1:8000/v1/chat/completions` through `lib/medgemma-adapter.mjs`:

- **JSON-schema enforcement**: Sends a strict JSON Schema via OpenAI-compatible `response_format` (`json_schema`, `strict: true`) with automatic fallback to vLLM `guided_json`, plus server-side schema validation before returning annotations.
- **Box-to-point conversion**: Requests MedGemma 1.5's native `box_2d` (`[y0, x0, y1, x1]` on the `0–1000` scale) and converts each bounding box into normalized `[0, 1]` `(x, y)` marker coordinates while preserving normalized box bounds (`{ x0, y0, x1, y1 }`) for canvas overlay and JSON export.

### Launch MedGemma 1.5 / MedGemma 1.5 4B with vLLM

1. Accept the Health AI Developer Foundations terms on [google/medgemma-1.5-4b-it](https://huggingface.co/google/medgemma-1.5-4b-it) and export your Hugging Face token (`HF_TOKEN`).
2. Start vLLM using one of the included launch configs:

```sh
# Default MedGemma 1.5 4B profile (16-24 GB GPU, up to 8 images per request)
export HF_TOKEN=your_hf_token
vllm serve --config vllm/medgemma-1.5-4b.yaml

# Or extended-context MedGemma 1.5 profile (24-80 GB GPU)
vllm serve --config vllm/medgemma-1.5.yaml

# Or via the helper script / Docker Compose
./vllm/launch-medgemma.sh 4b
# docker compose -f vllm/docker-compose.yml up
```

3. Start the Imaging Review server (`npm run dev`). No extra environment variables are required when using the default local vLLM port (`8000`).

### Override model or adapter settings

```sh
IMAGING_MODEL_URL=http://127.0.0.1:8000/v1/chat/completions \
IMAGING_MODEL=google/medgemma-1.5-4b-it \
IMAGING_ADAPTER=auto \
IMAGING_SCHEMA_MODE=response_format \
npm run dev
```

Set `IMAGING_MODEL_KEY` on the server if your endpoint requires a bearer token. The key stays server-side. The application does not record uploads or model responses on disk. A remote model receives sampled images and request text and may apply its own retention rules. Do not send studies containing identifying information, including burned-in identifiers.

### Model response format

In MedGemma mode (`IMAGING_ADAPTER=auto` or `medgemma`), the model returns `box_2d` (`[y0, x0, y1, x1]` on `0–1000`), which the adapter validates and converts to normalized `(x, y)` points plus `box`:

```json
{"summary":"Example observation","limitations":"Only one frame supplied","annotations":[{"frame":0,"label":"Example landmark","kind":"anatomy","box_2d":[460,370,560,470]}]}
```

Frame indices start at zero. Annotation types are `anatomy` and `finding`. Point-based models (`IMAGING_ADAPTER=point`) returning normalized `x` and `y` in `[0, 1]` remain supported.

## Clinical scope

AI suggestions are preliminary and require clinician verification. Sampled frames can miss pathology and cannot replace review of the original series and formal radiology interpretation. The bundled case is a schematic for teaching. Model accuracy and coordinate localization require independent validation before any clinical use.

## Vercel

Import the repository root as an Other project. The deployed viewer supports manual review and the PE teaching schematic. Vercel serves the viewer and forwards authorized AI requests to a separate model server. To enable hosted MedGemma, set these Production environment variables and redeploy:

- `IMAGING_MODEL_URL` — externally reachable HTTPS URL ending in `/v1/chat/completions` for a vLLM service already serving MedGemma.
- `IMAGING_MODEL_KEY` — model server bearer token, if required.
- `IMAGING_REVIEW_ACCESS_TOKEN` — independent high-entropy access code shared only with approved reviewers. Enter this code in the viewer.
- `IMAGING_MODEL` — optional override if the served model name differs from `google/medgemma-1.5-4b-it`.

`GET /api/config` reports configuration without exposing credentials or the model endpoint. It does not call inference. Verify the model with a de-identified or synthetic image before any approved use. Hosted AI remains disabled until the endpoint and access code are configured.
