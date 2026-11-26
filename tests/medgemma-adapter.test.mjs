import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL,
  DEFAULT_UPSTREAM,
  boxToPoint,
  buildReviewSchema,
  buildChatCompletionRequest,
  parseReviewResponse,
  resolveAdapterMode
} from '../lib/medgemma-adapter.mjs';

test('defaults target Google MedGemma 1.5 4B on local vLLM', () => {
  assert.equal(DEFAULT_MODEL, 'google/medgemma-1.5-4b-it');
  assert.equal(DEFAULT_UPSTREAM, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(resolveAdapterMode(DEFAULT_MODEL, 'auto'), 'medgemma');
  assert.equal(resolveAdapterMode('custom-point-model', 'auto'), 'point');
  assert.equal(resolveAdapterMode('custom-model', 'medgemma'), 'medgemma');
});

test('boxToPoint converts MedGemma [y0, x0, y1, x1] 0..1000 coordinates to normalized center point', () => {
  const result = boxToPoint([400, 200, 600, 400]);
  assert.deepEqual(result, {
    x: 0.3,
    y: 0.5,
    box: { x0: 0.2, y0: 0.4, x1: 0.4, y1: 0.6 }
  });
});

test('boxToPoint handles inverted corners and fractional 0..1 boxes safely', () => {
  const inverted = boxToPoint([700, 800, 300, 400]);
  assert.deepEqual(inverted, {
    x: 0.6,
    y: 0.5,
    box: { x0: 0.4, y0: 0.3, x1: 0.8, y1: 0.7 }
  });

  const fractional = boxToPoint([0.2, 0.1, 0.4, 0.5]);
  assert.deepEqual(fractional, {
    x: 0.3,
    y: 0.3,
    box: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.4 }
  });

  assert.equal(boxToPoint([0, 0, 1001, 500]), null);
  assert.equal(boxToPoint([-1, 0, 500, 500]), null);
  assert.equal(boxToPoint([100, 200, 300]), null);
});

test('buildReviewSchema enforces strict schema and dynamic frame upper bound', () => {
  const schema = buildReviewSchema(4, 'medgemma');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['summary', 'limitations', 'annotations']);
  assert.equal(schema.properties.annotations.items.properties.frame.maximum, 3);
  assert.deepEqual(schema.properties.annotations.items.required, ['frame', 'label', 'kind', 'box_2d']);
});

test('buildChatCompletionRequest attaches response_format or guided_json schema enforcement', () => {
  const data = {
    modality: 'CT',
    request: 'Assess pulmonary arteries.',
    frames: [{ time: 0.5, image: 'data:image/jpeg;base64,/9j/abc' }]
  };

  const rfBody = buildChatCompletionRequest({ model: DEFAULT_MODEL, data, schemaMode: 'response_format' });
  assert.equal(rfBody.model, DEFAULT_MODEL);
  assert.equal(rfBody.response_format.type, 'json_schema');
  assert.equal(rfBody.response_format.json_schema.strict, true);
  assert.equal(rfBody.guided_json, undefined);

  const guidedBody = buildChatCompletionRequest({ model: DEFAULT_MODEL, data, schemaMode: 'guided_json' });
  assert.equal(guidedBody.response_format, undefined);
  assert.equal(guidedBody.guided_json.type, 'object');
});

test('parseReviewResponse strips thinking tokens, converts box_2d to points, and enforces schema', () => {
  const raw = {
    choices: [
      {
        message: {
          content: '<unused94>thought\nInspecting RPA.\n<unused95>```json\n' + JSON.stringify({
            summary: 'Suspected intraluminal filling defect in the right pulmonary artery.',
            limitations: 'Single sampled CT slice.',
            annotations: [
              { frame: 0, label: 'Suspected right pulmonary artery filling defect', kind: 'finding', box_2d: [480, 280, 580, 380] },
              { frame: 0, label: 'Main pulmonary artery', kind: 'anatomy', x: 0.51, y: 0.4 },
              { frame: 5, label: 'Out of range frame', kind: 'anatomy', box_2d: [100, 100, 200, 200] }
            ]
          }) + '\n```'
        }
      }
    ]
  };

  const parsed = parseReviewResponse(raw, 1);
  assert.equal(parsed.annotations.length, 2);
  assert.deepEqual(parsed.annotations[0], {
    frame: 0,
    label: 'Suspected right pulmonary artery filling defect',
    kind: 'finding',
    x: 0.33,
    y: 0.53,
    box: { x0: 0.28, y0: 0.48, x1: 0.38, y1: 0.58 }
  });
  assert.deepEqual(parsed.annotations[1], {
    frame: 0,
    label: 'Main pulmonary artery',
    kind: 'anatomy',
    x: 0.51,
    y: 0.4
  });
});

test('parseReviewResponse rejects responses violating the review JSON schema', () => {
  assert.throws(() => parseReviewResponse({
    choices: [{ message: { content: JSON.stringify({ summary: 'ok', annotations: [] }) } }]
  }, 1));

  assert.throws(() => parseReviewResponse({
    choices: [{ message: { content: JSON.stringify({ summary: 'ok', limitations: 'none', annotations: [], extra: 1 }) } }]
  }, 1));
});
