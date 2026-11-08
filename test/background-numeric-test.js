'use strict';
const assert = require('node:assert/strict');
const settings = {apiKey:'fake',model:'test',baseUrl:'https://example.invalid',useCache:false};
const values = {};
let listener, nextContent, calls=0, lastRequest;
const storage = {
 async get(key) { return key === 'mcqSettings' ? {mcqSettings:settings} : {[key]:values[key]}; },
 async set(data) {Object.assign(values,data);}, async remove() {}
};
global.chrome={storage:{local:storage,session:storage},runtime:{onMessage:{addListener(fn){listener=fn}},onInstalled:{addListener(){}}},tabs:{onRemoved:{addListener(){}}}};
global.fetch=async (_url,opts)=>{calls++;lastRequest=JSON.parse(opts.body);return {ok:true,status:200,json:async()=>({choices:[{message:{content:nextContent}}]})}};
require('../background.js');
const send=payload=>new Promise(resolve=>listener({type:'MCQ_SOLVE',payload},{},resolve));
const q={type:'numeric',hash:'numeric-case',stem:'Find the requested number.',options:[]};
const cases=[
 ['JSON整数','{"value":"4","confidence":0.9,"reason":"test"}','4'],
 ['数值0','{"value":0}','0'],
 ['负小数','{"value":"-2.5"}','-2.5'],
 ['科学计数','{"value":"1e-3"}','0.001'],
 ['裸数值','4','4'],
 ['代码围栏','```json\n{"value":"4"}\n```','4'],
 ['缺失数字','{"value":null}',null],
 ['空字符串','{"value":""}',null],
 ['字母选项','{"answers":["A"]}',null],
 ['数字带单位','{"value":"4 hours"}',null],
 ['无穷大','{"value":"1e999"}',null],
 ['多个数字','{"value":[4,5]}',null]
];
(async()=>{
 let passed=0;
 for(const [name,content,value]of cases){nextContent=content;const result=await send(q);assert.equal(result.ok,value!==null,name);if(value!==null)assert.equal(result.value,value,name);passed++;console.log('PASS — '+name);}
 assert(lastRequest.messages[0].content.includes('"value"'));
 assert(lastRequest.messages[1].content.includes('numerical input'));
 assert(!lastRequest.messages[1].content.includes('Options:'));
 passed++;console.log('PASS — numeric使用独立JSON协议且不伪造选项');
 settings.useCache=true;nextContent='{"value":"4","reason":"test"}';
 const a=await send(q),before=calls,b=await send(q);assert.equal(a.value,'4');assert.equal(b.value,'4');assert.equal(b.cached,true);assert.equal(calls,before);
 passed++;console.log('PASS — 数值答案缓存可复用');
 settings.useCache=false;nextContent='{"answers":["B"],"confidence":1}';
 const mcq=await send({type:'single',hash:'choice',stem:'Pick one.',options:[{letter:'A',text:'One'},{letter:'B',text:'Two'}]});
 assert.deepEqual(mcq.letters,['B']);assert(lastRequest.messages[0].content.includes('"answers"'));
 passed++;console.log('PASS — 原选择题协议继续生效');
 console.log(`background-numeric-test: ${passed}/15`);
})().catch(error=>{console.error(error);process.exitCode=1});
