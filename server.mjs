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
} from './lib/medgemma-adapter.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const upstream = (process.env.IMAGING_MODEL_URL ?? DEFAULT_UPSTREAM).trim();
const model = (process.env.IMAGING_MODEL || DEFAULT_MODEL).trim();
const key = process.env.IMAGING_MODEL_KEY;
const adapterMode = resolveAdapterMode(model, process.env.IMAGING_ADAPTER);
const schemaMode = resolveSchemaMode(process.env.IMAGING_SCHEMA_MODE);
const maxTokens = resolveMaxTokens(process.env.IMAGING_MAX_TOKENS);

const assets = new Map([
 ['/', ['index.html', 'text/html; charset=utf-8']],
 ['/index.html', ['index.html', 'text/html; charset=utf-8']],
 ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
 ['/pe-case.svg', ['pe-case.svg', 'image/svg+xml']]
]);
const maxBody = 4 * 1024 * 1024;
const modalities = ['CT','MRI','X-ray'];
let inFlight = false;
function json(res,status,body) {
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
 res.end(JSON.stringify(body));
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
async function postCompletion(endpoint,headers,body) {
 try{
  return await fetch(endpoint,{
   method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(60000),
   body:JSON.stringify(body)
  });
 }catch(error){
  const err=new Error('Unable to reach the configured imaging model endpoint.');
  err.status=503;
  err.cause=error;
  throw err;
 }
}
async function runReview(data) {
 const endpoint=new URL(upstream);
 const local=['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname);
 if(endpoint.protocol!=='https:'&&!(local&&endpoint.protocol==='http:')){
  const err=new Error('Model requires HTTPS or a loopback endpoint.');
  err.status=502;
  throw err;
 }
 const headers={'Content-Type':'application/json'};
 if(key)headers.Authorization='Bearer '+key;

 const primaryBody=buildChatCompletionRequest({model,data,adapterMode,schemaMode,maxTokens});
 let response=await postCompletion(endpoint,headers,primaryBody);

 // Automatic fallback for older vLLM servers that expect top-level guided_json instead of response_format
 if(!response.ok&&schemaMode==='response_format'&&(response.status===400||response.status===422)){
  const fallbackBody=buildChatCompletionRequest({model,data,adapterMode,schemaMode:'guided_json',maxTokens});
  response=await postCompletion(endpoint,headers,fallbackBody);
 }

 if(!response.ok){
  const err=new Error('Model rejected the request.');
  err.status=502;
  throw err;
 }
 return parseReviewResponse(await response.json(),data.frames.length);
}
const server=createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 const pathname=new URL(req.url||'/','http://localhost').pathname;
 if(pathname==='/api/config'&&req.method==='GET'){
  return json(res,200,{
   defaultModel:DEFAULT_MODEL,
   model,
   adapter:adapterMode,
   schemaEnforcement:schemaMode,
   endpointConfigured:Boolean(upstream)
  });
 }
 if(pathname==='/api/review'&&req.method==='POST'){
  const origin=req.headers.origin;
  if(origin){
   let originHost='';
   try{originHost=new URL(origin).host}catch{}
   if(!originHost||originHost!==req.headers.host)return json(res,403,{error:'Use the application address to submit a review.'});
  }
  if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'Expected JSON.'});
  if(!upstream||!model)return json(res,503,{error:'AI review requires a configured imaging model. Manual annotation remains available.'});
  if(inFlight)return json(res,429,{error:'Another review is running.'});
  if(Number(req.headers['content-length'])>maxBody)return json(res,413,{error:'Request exceeds 4 MB.'});
  inFlight=true;
  try{
   let data;
   try{data=await payload(req)}catch{return json(res,400,{error:'Unable to read the review request within the 4 MB limit.'})}
   if(!validInput(data))return json(res,400,{error:'Use 1–8 JPEG frames and a request of 1–1,500 characters.'});
   try{
    return json(res,200,await runReview(data));
   }catch(err){
    if(err?.status===503){
     return json(res,503,{error:`Could not reach the vLLM endpoint for ${model}. Start vLLM with vllm/medgemma-1.5-4b.yaml or set IMAGING_MODEL_URL. Manual annotation remains available.`});
    }
    return json(res,502,{error:'The imaging model did not return a valid review matching the JSON schema. Check the model configuration and try again.'});
   }
  }finally{inFlight=false}
 }
 const asset=(req.method==='GET'||req.method==='HEAD')&&assets.get(pathname);
 if(!asset)return json(res,404,{error:'Page not found.'});
 try{
  const bytes=await readFile(new URL('public/'+asset[0],import.meta.url));
  res.writeHead(200,{'Content-Type':asset[1],'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'"});
  res.end(req.method==='HEAD'?undefined:bytes);
 }catch{json(res,500,{error:'Unable to load the application.'})}
});
server.requestTimeout=65000;
server.listen(port,host,()=>console.log(`Imaging Review is available at http://${host}:${port} (model: ${model}, adapter: ${adapterMode})`));
