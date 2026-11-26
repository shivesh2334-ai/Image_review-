import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {
 DEFAULT_MODEL,
 DEFAULT_UPSTREAM,
 buildChatCompletionRequest,
 parseReviewResponse,
 resolveAdapterMode,
 resolveMaxTokens,
 resolveSchemaMode
} from './medgemma-adapter.mjs';

const maxBody = 4 * 1024 * 1024;
const modalities = ['CT', 'MRI', 'X-ray'];

function settings(hosted, env) {
 const model = env.IMAGING_MODEL?.trim() || DEFAULT_MODEL;
 const adapter = resolveAdapterMode(model, env.IMAGING_ADAPTER);
 const schemaEnforcement = resolveSchemaMode(env.IMAGING_SCHEMA_MODE);
 const accessToken = env.IMAGING_REVIEW_ACCESS_TOKEN?.trim();
 let endpoint;
 try {
  const url = new URL(env.IMAGING_MODEL_URL ?? (hosted ? '' : DEFAULT_UPSTREAM));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url.username && !url.password &&
      (hosted ? !loopback && url.protocol === 'https:' : url.protocol === 'https:' || loopback && url.protocol === 'http:')) endpoint = url;
 } catch {}
 return {model, adapter, schemaEnforcement, accessToken, endpoint,
  endpointConfigured: Boolean(endpoint && (!hosted || accessToken)),
  accessTokenRequired: hosted, maxTokens: resolveMaxTokens(env.IMAGING_MAX_TOKENS),
  key: env.IMAGING_MODEL_KEY};
}

export function modelConfig(hosted, env = process.env) {
 const {model, adapter, schemaEnforcement, endpointConfigured, accessTokenRequired} = settings(hosted, env);
 return {defaultModel: DEFAULT_MODEL, model, adapter, schemaEnforcement, endpointConfigured, accessTokenRequired};
}
async function payload(req) {
 let length=0;
 const chunks=[];
 for await(const chunk of req){
  length+=chunk.length;
  if(length>maxBody)throw Error('Request exceeds 4 MB.');
  chunks.push(chunk);
 }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function validInput(data) {
 return data?.consent===true&&modalities.includes(data.modality)&&
  typeof data.request==='string'&&data.request.trim().length>0&&data.request.length<=1500&&
  Array.isArray(data.frames)&&data.frames.length>=1&&data.frames.length<=8&&
  data.frames.every(f=>Number.isFinite(f?.time)&&f.time>=0&&typeof f.image==='string'&&
   f.image.length<=500000&&/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+=*$/.test(f.image));
}

import {timingSafeEqual} from 'node:crypto';

function matchesToken(actual, expected) {
 const a = Buffer.from(actual || '');
 const b = Buffer.from(expected);
 return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleReview(req, {hosted = false, env = process.env, send}) {
 const fail = (status, error) => send(status, {error});
 if (req.method !== 'POST') return fail(405, 'Use POST to submit a review.');
 const origin = req.headers.origin;
 if (origin && origin !== (hosted ? 'https://' : 'http://') + req.headers.host &&
     (hosted || origin !== 'https://' + req.headers.host)) return fail(403, 'Use the application address to submit a review.');
 if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'Expected JSON.');
 const config = settings(hosted, env);
 if (!config.endpointConfigured) return fail(503, hosted
  ? 'Hosted MedGemma needs an HTTPS model endpoint and a review access code. Manual annotation remains available.'
  : 'AI review needs a valid model endpoint. Manual annotation remains available.');
 if (hosted && !matchesToken(req.headers['x-imaging-review-token'], config.accessToken)) return fail(401, 'Enter a valid AI review access code.');
 if (Number(req.headers['content-length']) > maxBody) return fail(413, 'Request exceeds 4 MB.');
 let data;
 try {
  data = req.body === undefined ? await payload(req) : req.body;
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
   if (Buffer.byteLength(data) > maxBody) return fail(413, 'Request exceeds 4 MB.');
   data = JSON.parse(data.toString());
  }
 } catch { return fail(400, 'Unable to read the imaging review JSON.'); }
 if (!validInput(data)) return fail(400, 'Confirm de-identification and provide 1–8 JPEG frames and a request of 1–1,500 characters.');
 const headers = {'Content-Type': 'application/json'};
 if (config.key) headers.Authorization = 'Bearer ' + config.key;
 const signal = AbortSignal.timeout(55000);
 const complete = schemaMode => fetch(config.endpoint, {
  method: 'POST', headers, signal, redirect: 'error',
  body: JSON.stringify(buildChatCompletionRequest({
   model: config.model, data, adapterMode: config.adapter, schemaMode, maxTokens: config.maxTokens
  }))
 });
 let response;
 try {
  response = await complete(config.schemaEnforcement);
  if (config.schemaEnforcement === 'response_format' && [400, 422].includes(response.status)) {
   await response.body?.cancel();
   response = await complete('guided_json');
  }
 } catch {
  return fail(signal.aborted ? 504 : 503, signal.aborted ? 'The imaging model timed out.' : 'Unable to reach the imaging model endpoint.');
 }
 if (response.status === 401 || response.status === 403) return fail(502, 'The imaging model rejected its server credentials.');
 if (response.status === 429) return fail(503, 'The imaging model is busy. Try fewer frames or retry later.');
 if (!response.ok) return fail(502, 'The imaging model rejected the request. Verify the served model name, schema mode and image limit.');
 try { return send(200, parseReviewResponse(await response.json(), data.frames.length)); }
 catch { return fail(502, 'The imaging model response did not contain a valid review.'); }
}
