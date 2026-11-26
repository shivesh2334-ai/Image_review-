import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
const upstream = process.env.IMAGING_MODEL_URL;
const model = process.env.IMAGING_MODEL;
const key = process.env.IMAGING_MODEL_KEY;
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
function parseReview(response, count) {
 const content=response?.choices?.[0]?.message?.content;
 if(typeof content!=='string'||content.length>22000)throw Error('Invalid model response.');
 const result=JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/gi,''));
 if(!result||typeof result.summary!=='string'||typeof result.limitations!=='string'||!Array.isArray(result.annotations)){
  throw Error('Invalid model response.');
 }
 return {
  summary:result.summary.slice(0,3500),limitations:result.limitations.slice(0,1500),
  annotations:result.annotations.slice(0,20).filter(a=>a&&Number.isInteger(a.frame)&&a.frame>=0&&a.frame<count&&
   typeof a.label==='string'&&a.label.trim()&&['anatomy','finding'].includes(a.kind)&&
   [a.x,a.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))
   .map(({frame,label,kind,x,y})=>({frame,label:label.trim().slice(0,120),kind,x,y}))
 };
}
async function runReview(data) {
 const endpoint=new URL(upstream);
 const local=['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname);
 if(endpoint.protocol!=='https:'&&!(local&&endpoint.protocol==='http:'))throw Error('Model requires HTTPS or a loopback endpoint.');
 const headers={'Content-Type':'application/json'};
 if(key)headers.Authorization='Bearer '+key;
 const content=[{type:'text',text:'Modality: '+data.modality+'\nReview request: '+data.request}];
 data.frames.forEach(({image,time},i)=>{
  content.push({type:'text',text:'Frame index '+i+' at '+time.toFixed(3)+' seconds'});
  content.push({type:'image_url',image_url:{url:image}});
 });
 const instructions=`Assist a qualified clinician with preliminary review of the provided sampled images. Report only observations supported by the images. Distinguish possible pathology and artifact, and describe limitations including missing slices, sequences or windows where relevant. If uncertain, explicitly state what cannot be assessed and omit uncertain marker locations. Do not infer laterality without adequate evidence, diagnose definitively, recommend treatment or exclude disease from a limited sample. Return only JSON with summary (string), limitations (string), and annotations (array of objects with zero-based frame, label, kind "anatomy" or "finding", and x and y as normalized fractions measured from the top-left of the image). Use suspected wording for pathological findings. Return an empty annotations array when no defensible location is visible.`;
 const response=await fetch(endpoint,{
  method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(45000),
  body:JSON.stringify({model,messages:[{role:'system',content:instructions},{role:'user',content}]})
 });
 if(!response.ok)throw Error('Model rejected the request.');
 return parseReview(await response.json(),data.frames.length);
}
const server=createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){
  return json(res,403,{error:'Use the local application address.'});
 }
 if(req.url==='/api/review'&&req.method==='POST'){
  const origin=req.headers.origin;
  if(origin&&origin!=='http://'+req.headers.host)return json(res,403,{error:'Use the local application to submit a review.'});
  if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'Expected JSON.'});
  if(!upstream||!model)return json(res,503,{error:'AI review requires a configured imaging model. Manual annotation remains available.'});
  if(inFlight)return json(res,429,{error:'Another review is running.'});
  if(Number(req.headers['content-length'])>maxBody)return json(res,413,{error:'Request exceeds 4 MB.'});
  inFlight=true;
  try{
   let data;
   try{data=await payload(req)}catch{return json(res,400,{error:'Unable to read the review request within the 4 MB limit.'})}
   if(!validInput(data))return json(res,400,{error:'Use 1–8 JPEG frames and a request of 1–1,500 characters.'});
   try{return json(res,200,await runReview(data))}catch{return json(res,502,{error:'The imaging model did not return a valid review. Check the model configuration and try again.'})}
  }finally{inFlight=false}
 }
 const asset=req.method==='GET'&&assets.get(req.url);
 if(!asset)return json(res,404,{error:'Page not found.'});
 try{
  const bytes=await readFile(new URL('public/'+asset[0],import.meta.url));
  res.writeHead(200,{'Content-Type':asset[1],'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"});
  res.end(bytes);
 }catch{json(res,500,{error:'Unable to load the application.'})}
});
server.requestTimeout=20000;
server.listen(port,host,()=>console.log(`Imaging Review is available at http://${host}:${port}`));
