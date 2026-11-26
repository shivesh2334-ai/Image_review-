import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {handleReview, modelConfig} from './lib/imaging-review.mjs';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const assets = new Map([
 ['/', ['index.html', 'text/html; charset=utf-8']],
 ['/index.html', ['index.html', 'text/html; charset=utf-8']],
 ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
 ['/pe-case.svg', ['pe-case.svg', 'image/svg+xml']]
]);
let inFlight = false;
function json(res,status,body) {
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
 res.end(JSON.stringify(body));
}
const server=createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 const pathname=new URL(req.url||'/','http://localhost').pathname;
 if(pathname==='/api/config'&&req.method==='GET') return json(res,200,modelConfig(false));
 if(pathname==='/api/review'){
  if(inFlight)return json(res,429,{error:'Another review is running.'});
  inFlight=true;
  try{return await handleReview(req,{send:(status,body)=>json(res,status,body)})}
  finally{inFlight=false}
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
server.listen(port,host,()=>console.log(`Imaging Review is available at http://${host}:${port}`));
