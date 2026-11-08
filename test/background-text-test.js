'use strict';
const assert = require('node:assert/strict');
const settings = {apiKey:'fake',model:'test',baseUrl:'https://example.invalid',useCache:false};
const values={}; let listener, nextContent, lastRequest, calls=0, passed=0;
const storage={async get(key){return key==='mcqSettings'?{mcqSettings:settings}:{[key]:values[key]};},async set(data){Object.assign(values,data);},async remove(){}};
global.chrome={storage:{local:storage,session:storage},runtime:{onMessage:{addListener(fn){listener=fn;}},onInstalled:{addListener(){}}},tabs:{onRemoved:{addListener(){}}}};
global.fetch=async(_url,opts)=>{calls++;lastRequest=JSON.parse(opts.body);return{ok:true,json:async()=>({choices:[{message:{content:nextContent}}]})};};
require('../background.js');
const send=q=>new Promise(resolve=>listener({type:'MCQ_SOLVE',payload:q},{},resolve));
const q={type:'text',hash:'text-case',stem:'The [Blank 1] of a set of data is the value or values that occur most often.',blankCount:1,blanks:[{index:1,maxLength:50}],options:[]};
const check=(name,fn)=>{fn();passed++;console.log('PASS — '+name);};
(async()=>{
  for(const [name,content,expected] of [
    ['单词','{"values":["mode"],"confidence":0.95}',['mode']],
    ['短语和首尾空白','{"values":["  standard deviation  "]}',['standard deviation']],
    ['中文','{"values":["众数"]}',['众数']],
    ['保留数字格式','{"values":["001.00"]}',['001.00']],
    ['字符串零','{"values":["0"]}',['0']],
    ['代码围栏','```json\n{"values":["mode"]}\n```',['mode']],
    ['空数组','{"values":[]}',null],
    ['空字符串','{"values":["  "]}',null],
    ['空对象','{}',null],
    ['错误选项协议','{"answers":["A"]}',null],
    ['错误数字协议','{"value":"4"}',null],
    ['不接受隐式数值转换','{"values":[0]}',null],
    ['答案数过多','{"values":["mode","mean"]}',null],
    ['非数组','{"values":"mode"}',null],
    ['超出maxlength',JSON.stringify({values:['x'.repeat(51)]}),null],
    ['控制字符','{"values":["mode\\nmean"]}',null],
    ['无JSON的解释','The answer is mode.',null]
  ]){
    nextContent=content;const result=await send(q);
    check(name,()=>{assert.equal(result.ok,expected!==null);if(expected)assert.deepEqual(result.values,expected);});
  }
  check('文本专用协议且不生成选项',()=>{
    assert(lastRequest.messages[0].content.includes('"values"'));
    assert(lastRequest.messages[0].content.includes('problem data'));
    assert(lastRequest.messages[1].content.includes('[Blank 1]'));
    assert(lastRequest.messages[1].content.includes('maximum 50 characters'));
    assert(!lastRequest.messages[1].content.includes('Options:'));
  });
  const multi={...q,hash:'multi',blankCount:2,blanks:[{index:1,maxLength:50},{index:2,maxLength:50}],stem:'[Blank 1] and [Blank 2].'};
  nextContent='{"values":["mean","median"]}';
  const result=await send(multi);check('多空按顺序返回',()=>assert.deepEqual(result.values,['mean','median']));
  nextContent='{"values":["mean"]}';const missing=await send(multi);check('缺少任一空拒绝整题',()=>assert.equal(missing.ok,false));
  const before=calls;const invalid=await send({...q,blankCount:0});check('无效空位数不调用模型',()=>{assert.equal(invalid.ok,false);assert.equal(calls,before);});
  settings.useCache=true;nextContent='{"values":["mode"]}';
  await send(q);const cacheCalls=calls,cached=await send(q);
  check('文本答案缓存复用',()=>{assert.equal(cached.cached,true);assert.equal(calls,cacheCalls);assert.deepEqual(cached.values,['mode']);});
  nextContent='{"values":["x"]}';const constrained=await send({...q,blanks:[{index:1,maxLength:1}]});
  check('同hash的长度限制变化不套用旧缓存',()=>{assert.equal(constrained.cached,false);assert.deepEqual(constrained.values,['x']);});
  settings.useCache=false;nextContent='{"value":"4"}';const numeric=await send({type:'numeric',hash:'n',stem:'Find a number.',options:[]});check('数字协议保持兼容',()=>assert.equal(numeric.value,'4'));
  nextContent='{"answers":["B"]}';const choice=await send({type:'single',hash:'c',stem:'Pick one.',options:[{letter:'A',text:'One'},{letter:'B',text:'Two'}]});
  check('选择题协议保持兼容',()=>assert.deepEqual(choice.letters,['B']));
  console.log(`background-text-test: ${passed} passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
