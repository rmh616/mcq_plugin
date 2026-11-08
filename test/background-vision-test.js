'use strict';
const assert = require('node:assert/strict');
const settings = {apiKey:'fake',model:'vision-test',baseUrl:'https://example.invalid',useCache:true};
const values = {}; let listener, last, calls=0, fail=false, imageRequests=[];
const storage={async get(k){return k==='mcqSettings'?{mcqSettings:settings}:{[k]:values[k]}},async set(v){Object.assign(values,v)},async remove(){}};
global.chrome={storage:{local:storage,session:storage},runtime:{onMessage:{addListener(fn){listener=fn}},onInstalled:{addListener(){}}},tabs:{onRemoved:{addListener(){}}}};
global.fetch=async (url,options)=>{
 if(!String(url).endsWith('/chat/completions')){imageRequests.push(options);return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}})}
 calls++;last=JSON.parse(options.body);
 return fail?{ok:false,status:400,text:async()=> 'This model does not support image inputs'}:{ok:true,json:async()=>({choices:[{message:{content:'{"answers":["B"],"confidence":1}'}}]})};
};
require('../background.js');
const send=payload=>new Promise(resolve=>listener({type:'MCQ_SOLVE',payload},{url:'https://canvas.example/quiz'},resolve));
const q={hash:'same-text',stem:'Use the graph.',type:'single',options:[{letter:'A',text:'One'},{letter:'B',text:'Two'}]};
let passed=0;
function check(name,ok){assert(ok,name);passed++;console.log('PASS — '+name)}
(async()=>{
 const first={...q,images:[{label:'Question image',dataUrl:'data:image/png;base64,AQID'}]};
 check('图文请求返回答案',(await send(first)).ok);
 const content=last.messages[1].content;
 check('使用text+image_url和high细节',Array.isArray(content)&&content[0].type==='text'&&content[2].image_url.detail==='high'&&content[2].image_url.url===first.images[0].dataUrl);
 check('图片标签保留',content[1].text==='Question image');
 const before=calls;check('相同图片字节缓存复用',(await send(first)).cached&&calls===before);
 check('文字相同图片不同不复用缓存',!(await send({...first,images:[{dataUrl:'data:image/png;base64,BAUG'}]})).cached&&calls===before+1);
 check('无图仍为文字协议',(await send({...q,hash:'plain'})).ok&&typeof last.messages[1].content==='string');
 const invalidBefore=calls;
 for(const images of [[{dataUrl:'data:image/svg+xml;base64,AQID'}],[{url:'file:///secret'}],Array(9).fill(first.images[0]),[{dataUrl:'not an image'}]]) check('拒绝无效或超限图片',!(await send({...q,images})).ok);
 check('无效图片不会静默降级成文字',calls===invalidBefore);
 check('后台获取需登录图片后发送数据URL',(await send({...q,hash:'fetch-image',images:[{url:'https://canvas.example/files/graph'}]})).ok&&last.messages[1].content[2].image_url.url==='data:image/png;base64,AQID');
 check('同源图片带cookie但不带API认证头',imageRequests.at(-1).credentials==='include'&&!imageRequests.at(-1).headers);
 await send({...q,images:[{url:'https://cdn.example/graph'}]});
 check('第三方图片不带站点cookie',imageRequests.at(-1).credentials==='omit');
 settings.useCache=false;fail=true;
 const result=await send(first);
 check('模型不支持图像时明确失败',!result.ok&&result.error.includes('支持图片'));
 global.fetch=async()=>{const error=new Error('signal is aborted without reason');error.name='AbortError';throw error};
 const timeout=await send({...q,images:[{url:'https://canvas.example/slow-graph'}]});
 check('图片下载超时显示中文原因且不继续模型请求',!timeout.ok&&timeout.error.includes('下载超时（15秒）')&&!timeout.error.includes('signal is aborted'));
 console.log(`background-vision-test: ${passed} PASS`);
})().catch(error=>{console.error(error);process.exitCode=1});
