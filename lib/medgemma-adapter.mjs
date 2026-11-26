export const DEFAULT_MODEL = 'google/medgemma-1.5-4b-it';
export const DEFAULT_UPSTREAM = 'http://127.0.0.1:8000/v1/chat/completions';
export const DEFAULT_ADAPTER = 'auto';
export const DEFAULT_SCHEMA_MODE = 'response_format';
export const DEFAULT_MAX_TOKENS = 1200;

const VALID_KINDS = new Set(['anatomy', 'finding']);
const VALID_ADAPTERS = new Set(['auto', 'medgemma', 'point']);
const VALID_SCHEMA_MODES = new Set(['response_format', 'guided_json', 'none']);

const BASE_CLINICAL_RULES = [
  'Assist a qualified clinician with preliminary review of the provided sampled images.',
  'Report only observations supported by the images.',
  'Distinguish possible pathology and artifact, and describe limitations including missing slices, sequences or windows where relevant.',
  'If uncertain, explicitly state what cannot be assessed and omit uncertain marker locations.',
  'Do not infer laterality without adequate evidence, diagnose definitively, recommend treatment or exclude disease from a limited sample.',
  'Use suspected wording for pathological findings.',
  'Return an empty annotations array when no defensible location is visible.'
].join(' ');

export function resolveAdapterMode(model = DEFAULT_MODEL, configuredMode = DEFAULT_ADAPTER) {
  const mode = typeof configuredMode === 'string' ? configuredMode.trim().toLowerCase() : DEFAULT_ADAPTER;
  if (mode === 'medgemma' || mode === 'point') return mode;
  if (!VALID_ADAPTERS.has(mode)) return 'medgemma';
  return /medgemma/i.test(String(model || '')) ? 'medgemma' : 'point';
}

export function resolveSchemaMode(configuredMode = DEFAULT_SCHEMA_MODE) {
  const mode = typeof configuredMode === 'string' ? configuredMode.trim().toLowerCase() : DEFAULT_SCHEMA_MODE;
  return VALID_SCHEMA_MODES.has(mode) ? mode : DEFAULT_SCHEMA_MODE;
}

export function resolveMaxTokens(value = DEFAULT_MAX_TOKENS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
  return Math.max(256, Math.min(4096, Math.round(parsed)));
}

/**
 * Builds a strict JSON Schema for vLLM structured outputs (response_format / guided_json).
 * In MedGemma mode, localizations use MedGemma 1.5's native box_2d [y0, x0, y1, x1] in [0, 1000].
 */
export function buildReviewSchema(frameCount, adapterMode = 'medgemma') {
  const maxFrame = Math.max(0, Number.isInteger(frameCount) ? frameCount - 1 : 0);
  const annotationItem = adapterMode === 'medgemma'
    ? {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'label', 'kind', 'box_2d'],
        properties: {
          frame: { type: 'integer', minimum: 0, maximum: maxFrame },
          label: { type: 'string', minLength: 1, maxLength: 120 },
          kind: { type: 'string', enum: ['anatomy', 'finding'] },
          box_2d: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'number', minimum: 0, maximum: 1000 }
          }
        }
      }
    : {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'label', 'kind', 'x', 'y'],
        properties: {
          frame: { type: 'integer', minimum: 0, maximum: maxFrame },
          label: { type: 'string', minLength: 1, maxLength: 120 },
          kind: { type: 'string', enum: ['anatomy', 'finding'] },
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 }
        }
      };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'limitations', 'annotations'],
    properties: {
      summary: { type: 'string', maxLength: 3500 },
      limitations: { type: 'string', maxLength: 1500 },
      annotations: {
        type: 'array',
        maxItems: 20,
        items: annotationItem
      }
    }
  };
}

export function buildSystemInstructions(adapterMode = 'medgemma') {
  if (adapterMode === 'medgemma') {
    return `${BASE_CLINICAL_RULES} Return only valid JSON matching the required schema with keys "summary" (string), "limitations" (string), and "annotations" (array). Each annotation must contain zero-based "frame", "label", "kind" ("anatomy" or "finding"), and "box_2d" as [y0, x0, y1, x1] coordinates normalized to integers on a 0 to 1000 scale measured from the top-left corner of the image.`;
  }
  return `${BASE_CLINICAL_RULES} Return only valid JSON matching the required schema with keys "summary" (string), "limitations" (string), and "annotations" (array of objects with zero-based "frame", "label", "kind" "anatomy" or "finding", and "x" and "y" as normalized fractions between 0 and 1 measured from the top-left of the image).`;
}

export function buildChatCompletionRequest({
  model = DEFAULT_MODEL,
  data,
  adapterMode = resolveAdapterMode(model),
  schemaMode = DEFAULT_SCHEMA_MODE,
  maxTokens = DEFAULT_MAX_TOKENS
}) {
  const schema = buildReviewSchema(data.frames.length, adapterMode);
  const instructions = buildSystemInstructions(adapterMode);
  const content = [
    { type: 'text', text: `Modality: ${data.modality}\nReview request: ${data.request}` }
  ];

  data.frames.forEach(({ image, time }, index) => {
    content.push({ type: 'text', text: `Frame index ${index} at ${time.toFixed(3)} seconds` });
    content.push({ type: 'image_url', image_url: { url: image } });
  });

  const body = {
    model,
    temperature: 0,
    max_tokens: resolveMaxTokens(maxTokens),
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content }
    ]
  };

  if (schemaMode === 'response_format') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'imaging_review',
        strict: true,
        schema
      }
    };
  } else if (schemaMode === 'guided_json') {
    body.guided_json = schema;
  }

  return body;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Converts a MedGemma 1.5 bounding box [y0, x0, y1, x1] (0..1000 scale, or normalized 0..1 fractional scale)
 * into a normalized [0, 1] center point { x, y } plus normalized box { x0, y0, x1, y1 }.
 */
export function boxToPoint(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const nums = box.map(Number);
  if (!nums.every(v => Number.isFinite(v) && v >= 0 && v <= 1000)) return null;

  const isFractional01 = nums.every(v => v <= 1) && nums.some(v => !Number.isInteger(v));
  const scale = isFractional01 ? 1 : 1000;

  const [rawY0, rawX0, rawY1, rawX1] = nums.map(v => clamp01(v / scale));
  const y0 = Math.min(rawY0, rawY1);
  const y1 = Math.max(rawY0, rawY1);
  const x0 = Math.min(rawX0, rawX1);
  const x1 = Math.max(rawX0, rawX1);

  return {
    x: round4((x0 + x1) / 2),
    y: round4((y0 + y1) / 2),
    box: {
      x0: round4(x0),
      y0: round4(y0),
      x1: round4(x1),
      y1: round4(y1)
    }
  };
}

function readMessageContent(response) {
  const message = response?.choices?.[0]?.message;
  if (!message) return null;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return null;
}

export function extractJsonObject(rawContent) {
  if (typeof rawContent !== 'string' || rawContent.length === 0 || rawContent.length > 32000) {
    throw new Error('Invalid model response length.');
  }

  let text = rawContent
    .replace(/<unused94>thought[\s\S]*?<unused95>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('Model response is not valid JSON.');
  }
}

function normalizeAnnotation(item, frameCount) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (!Number.isInteger(item.frame) || item.frame < 0 || item.frame >= frameCount) return null;
  if (typeof item.label !== 'string' || !item.label.trim()) return null;
  if (!VALID_KINDS.has(item.kind)) return null;

  const label = item.label.trim().slice(0, 120);
  const boxInput = item.box_2d ?? item.bbox ?? item.box;

  if (Array.isArray(boxInput)) {
    const converted = boxToPoint(boxInput);
    if (!converted) return null;
    return {
      frame: item.frame,
      label,
      kind: item.kind,
      x: converted.x,
      y: converted.y,
      box: converted.box
    };
  }

  if (
    typeof item.x === 'number' &&
    typeof item.y === 'number' &&
    Number.isFinite(item.x) &&
    Number.isFinite(item.y) &&
    item.x >= 0 &&
    item.x <= 1 &&
    item.y >= 0 &&
    item.y <= 1
  ) {
    return {
      frame: item.frame,
      label,
      kind: item.kind,
      x: round4(item.x),
      y: round4(item.y)
    };
  }

  return null;
}

/**
 * Enforces the review JSON schema server-side and converts MedGemma box_2d localizations to points.
 */
export function validateAndNormalizeReview(parsed, frameCount) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model response must be a JSON object.');
  }

  const allowedTopLevelKeys = new Set(['summary', 'limitations', 'annotations']);
  for (const key of Object.keys(parsed)) {
    if (!allowedTopLevelKeys.has(key)) {
      throw new Error(`Unexpected top-level property "${key}" in model response.`);
    }
  }

  if (typeof parsed.summary !== 'string' || typeof parsed.limitations !== 'string' || !Array.isArray(parsed.annotations)) {
    throw new Error('Model response does not satisfy the review JSON schema.');
  }

  const annotations = parsed.annotations
    .slice(0, 20)
    .map(item => normalizeAnnotation(item, frameCount))
    .filter(Boolean);

  return {
    summary: parsed.summary.trim().slice(0, 3500),
    limitations: parsed.limitations.trim().slice(0, 1500),
    annotations
  };
}

export function parseReviewResponse(response, frameCount) {
  const rawContent = readMessageContent(response);
  if (rawContent === null) {
    throw new Error('Model response did not include message content.');
  }
  const parsed = extractJsonObject(rawContent);
  return validateAndNormalizeReview(parsed, frameCount);
}
