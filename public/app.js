'use strict';
const $=id=>document.getElementById(id);
const canvas=$('viewer'), ctx=canvas.getContext('2d');
const video=document.createElement('video');
video.muted=true; video.preload='auto';
let media=null,url='',name='',marks=[],review=null,placing=false,busy=false,frameSeconds=1/30, frameReady=false, seekQueue=Promise.resolve(), serial=0;
const message=s=>{$('status').textContent=s};
const clock=t=>Number(t).toFixed(2)+' s';
const current=()=>media===video?video.currentTime:0;
let aiConfig;
function controls(){
 const moving=media===video&&frameReady&&!busy;
 for(const id of ['back','next','time']) $(id).disabled=!moving;
 for(const id of ['mark','snapshot']) $(id).disabled=!media||!frameReady||busy;
 $('analyse').disabled=!media||!frameReady||busy||!aiConfig?.endpointConfigured;
 $('file').disabled=busy; $('demo').disabled=busy;
}
function draw(){
 ctx.fillStyle='#080d12';ctx.fillRect(0,0,canvas.width,canvas.height);
 if(!media||!frameReady){
  ctx.fillStyle='#b1c1cf';ctx.font='22px system-ui';ctx.fillText('Load a study to begin',30,65);return;
 }
 ctx.drawImage(media,0,0,canvas.width,canvas.height);
 for(const m of marks.filter(m=>Math.abs(m.time-current())<Math.max(frameSeconds/2,0.018))){
  const x=m.x*canvas.width,y=m.y*canvas.height;
  ctx.font='bold '+Math.max(13,canvas.width/48)+'px system-ui';
  const title=m.label+(m.source==='AI'?' · AI suggestion':'');
  const textWidth=ctx.measureText(title).width;
  const left=Math.max(0,Math.min(canvas.width-textWidth-10,x+13));
  const top=Math.max(0,y-26);
  const color=m.kind==='finding'?'#ffc56b':'#82dfdc';
  if(m.box){
   const bx=m.box.x0*canvas.width,by=m.box.y0*canvas.height;
   const bw=(m.box.x1-m.box.x0)*canvas.width,bh=(m.box.y1-m.box.y0)*canvas.height;
   if(bw>1&&bh>1){
    ctx.save();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.strokeRect(bx,by,bw,bh);ctx.restore();
   }
  }
  ctx.fillStyle='#09121bdc';ctx.fillRect(left,top,textWidth+10,23);
  ctx.strokeStyle=ctx.fillStyle=color;
  ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.stroke();
  ctx.fillText(title,left+5,top+17);
 }
 $('position').textContent=media===video?clock(current()):'Still image';
}
function list(){
 $('marks').replaceChildren();
 marks.forEach((m,i)=>{
  const li=document.createElement('li');li.className=m.kind==='finding'?'finding':'tag';
  const jump=document.createElement('button');jump.textContent=clock(m.time);
  jump.onclick=()=>{if(!busy) seek(m.time).catch(e=>message(e.message))};
  const label=document.createTextNode(' '+m.label+' · '+m.source+' ');
  const edit=document.createElement('button');edit.textContent='Rename';
  edit.onclick=()=>{const value=prompt('Annotation label',m.label)?.trim();if(value){m.label=value.slice(0,120);list();draw()}};
  const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=()=>{marks.splice(i,1);list();draw()};
  li.append(jump,label,edit,remove);$('marks').append(li);
 });
}
function reset(){
 serial++; if(url)URL.revokeObjectURL(url); url='';
 video.removeAttribute('src');video.load();
 media=null;frameReady=false;marks=[];review=null;placing=false;
 $('mark').setAttribute('aria-pressed','false');$('mark').textContent='Place marker';
 $('position').textContent='Still image';$('time').value=0;list();controls();draw();
}
function size(w,h){const ratio=Math.min(1,1100/Math.max(w,h));canvas.width=Math.max(1,Math.round(w*ratio));canvas.height=Math.max(1,Math.round(h*ratio))}
function seek(t){
 const revision=serial;
 const task=seekQueue.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
  if(revision!==serial||media!==video||!Number.isFinite(video.duration)||video.readyState<2)return resolve();
  const target=Math.max(0,Math.min(video.duration-0.001,t));
  if(Math.abs(target-video.currentTime)<0.0005){draw();return resolve()}
  const tidy=()=>{clearTimeout(timeout);video.removeEventListener('seeked',done)};
  const done=()=>{tidy();if(revision===serial){$('time').value=video.currentTime;draw()}resolve()};
  const timeout=setTimeout(()=>{tidy();reject(Error('Frame seek timed out.'))},3500);
  video.addEventListener('seeked',done,{once:true});video.currentTime=target;
 }));
 seekQueue=task;return task;
}
$('file').onchange=()=>{
 const file=$('file').files[0];if(!file)return;reset();name=file.name;url=URL.createObjectURL(file);
 const revision=serial;message('Loading study…');
 const failed=()=>{if(revision===serial){reset();message('Unable to open this file. Try MP4, WebM, JPEG or PNG.')}};
 if(file.type.startsWith('video/')||/\.(mp4|webm|mov)$/i.test(name)){
  media=video; frameSeconds=1/30;
  video.onerror=failed;
  video.onloadeddata=()=>{
   if(revision!==serial)return;
   if(!Number.isFinite(video.duration)||video.duration<=0)return failed();
   size(video.videoWidth,video.videoHeight);frameReady=true;$('time').max=video.duration;
   $('frameNote').textContent='Frame buttons step by approximately 33 ms. Timestamps refer to the video.';
   message('');controls();draw();
  };video.src=url;
 }else{
  const im=new Image();media=im;im.onload=()=>{if(revision!==serial)return;size(im.naturalWidth,im.naturalHeight);frameReady=true;$('frameNote').textContent='Still image';message('');controls();draw()};im.onerror=failed;im.src=url;
 }
};
$('time').onchange=e=>seek(Number(e.target.value)).catch(e=>message(e.message));
$('back').onclick=()=>seek(current()-frameSeconds).catch(e=>message(e.message));
$('next').onclick=()=>seek(current()+frameSeconds).catch(e=>message(e.message));
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('request').value=b.dataset.prompt;$('request').focus()});
$('mark').onclick=()=>{
 if(!placing&&!$('label').value.trim()){message('Enter a label before placing a marker.');$('label').focus();return}
 placing=!placing;$('mark').setAttribute('aria-pressed',String(placing));$('mark').textContent=placing?'Cancel marker':'Place marker';
 if(placing)message('Select a point on the image.');
};
canvas.onclick=e=>{
 if(!placing||!media||busy)return;
 const r=canvas.getBoundingClientRect();
 const scale=Math.min(r.width/canvas.width,r.height/canvas.height);
 const w=canvas.width*scale,h=canvas.height*scale;
 const x=(e.clientX-r.left-(r.width-w)/2)/w,y=(e.clientY-r.top-(r.height-h)/2)/h;
 if(x<0||x>1||y<0||y>1)return;
 const label=$('label').value.trim().slice(0,120);
 if(!label){message('Enter an annotation label.');return}
 marks.push({x,y,time:current(),label,kind:$('kind').value,source:'Manual'});
 $('mark').click();message('');list();draw();
};
function save(blob,name){const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
$('snapshot').onclick=()=>canvas.toBlob(b=>{if(b)save(b,'annotated-frame.png')});
$('export').onclick=()=>save(new Blob([JSON.stringify({study:name,modality:$('modality').value,request:$('request').value,review,annotations:marks},null,2)],{type:'application/json'}),'imaging-review.json');
$('analyse').onclick=async()=>{
 if(!$('consent').checked)return message('Confirm de-identification and approval before AI review.');
 const accessCode=$('reviewAccess').value.trim();
 if(aiConfig?.accessTokenRequired&&!accessCode)return message('Enter the AI review access code.');
 const request=$('request').value.trim();if(!request)return message('Enter a review request.');
 busy=true;controls();const start=current();message('Preparing selected images…');
 try{
  const times=media===video&&$('sampling').value==='sweep'?Array.from({length:8},(_,i)=>video.duration*(i+.5)/8):[start];
  const frames=[];
  for(const t of times){
   await seek(t);
   const w=media===video?video.videoWidth:media.naturalWidth,h=media===video?video.videoHeight:media.naturalHeight;
   const copy=document.createElement('canvas'),ratio=Math.min(1,768/Math.max(w,h));
   copy.width=Math.max(1,Math.round(w*ratio));copy.height=Math.max(1,Math.round(h*ratio));
   copy.getContext('2d').drawImage(media,0,0,copy.width,copy.height);
   frames.push({time:current(),image:copy.toDataURL('image/jpeg',.78)});
  }
  message('Reviewing '+frames.length+' selected image(s)…');
  const response=await fetch('/api/review',{method:'POST',headers:{'Content-Type':'application/json',...(accessCode?{'X-Imaging-Review-Token':accessCode}:{})},body:JSON.stringify({request,modality:$('modality').value,frames,consent:true})});
  const result=await response.json().catch(()=>({error:'Start the included review server to enable AI review.'}));
  if(!response.ok)throw Error(result.error||'Review failed.');
  review={summary:result.summary,limitations:result.limitations,frameTimes:frames.map(f=>f.time)};
  marks.push(...result.annotations.map(m=>({...m,time:frames[m.frame].time,source:'AI'})));
  list();message(review.summary+'\n\nLimitations: '+review.limitations);
 }catch(e){message(e.message)}finally{
  try{await seek(start)}catch{} busy=false;controls();draw();
 }
};
$('demo').onclick=async()=>{
 reset(); $('modality').value='CT';name='Pulmonary embolism teaching schematic';
 const revision=serial;
 const im=new Image();media=im;
 im.onload=()=>{if(revision!==serial)return;size(im.naturalWidth,im.naturalHeight);frameReady=true;
  marks=[{x:.51,y:.40,time:0,label:'Main pulmonary artery',kind:'anatomy',source:'Teaching'},{x:.33,y:.53,time:0,label:'Right pulmonary artery filling defect',kind:'finding',source:'Teaching'}];
  $('frameNote').textContent='Illustrative schematic · patient right is image left.';
  $('request').value='Show the illustrated right pulmonary artery filling defect.';
  message('Teaching example: a dark filling defect interrupts the contrast-filled right pulmonary artery. Review the full CTPA series to confirm a suspected embolus.');list();controls();draw()
 };im.src='pe-case.svg';
};
fetch('/api/config').then(r=>r.ok?r.json():null).then(cfg=>{
 aiConfig=cfg;
 $('reviewAccessRow').hidden=!cfg?.endpointConfigured||!cfg.accessTokenRequired;
 $('modelNote').textContent=cfg?.endpointConfigured
  ? `AI review sends sampled images and your request to ${cfg.model}. Manual review stays in your browser.`
  : 'AI review is unavailable until the model is configured. Manual review stays in your browser.';
}).catch(()=>{
 $('modelNote').textContent='AI configuration could not be loaded. Manual review stays in your browser.';
}).finally(controls);
controls();draw();
