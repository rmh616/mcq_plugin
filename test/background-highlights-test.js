'use strict';
const assert = require('node:assert/strict');
let listener;
const sent = [];
global.chrome = {
  storage:{local:{},session:{}},
  runtime:{onMessage:{addListener(fn){listener=fn}},onInstalled:{addListener(){}}},
  tabs:{sendMessage(...args){sent.push(args);return Promise.resolve({ok:true})},onRemoved:{addListener(){}}}
};
require('../background.js');
(async()=>{
  const sender = {tab:{id:7},frameId:3};
  const send = visible => new Promise(resolve=>listener({type:'MAS_HIGHLIGHTS_SET',payload:{visible}},sender,resolve));
  assert.deepEqual(await send(true),{ok:true});
  assert.deepEqual(sent[0],[7,{type:'MAS_HIGHLIGHTS',payload:{visible:true}}]);
  console.log('PASS — 子frame按住只广播到所在标签页的全部frame');
  await send(false);
  assert.deepEqual(sent[1],[7,{type:'MAS_HIGHLIGHTS',payload:{visible:false}}]);
  console.log('PASS — 松开广播隐藏状态');
  listener({type:'MAS_HIGHLIGHTS_SET',payload:{visible:'true'}},sender,()=>{});
  listener({type:'MAS_HIGHLIGHTS_SET'},{tab:{id:8}},()=>{});
  assert.equal(sent.length,2);
  console.log('PASS — 不转发无效显示状态');
  listener({type:'MAS_HIGHLIGHTS_SET',payload:{visible:true}},{},()=>{});
  assert.equal(sent.length,2);
  console.log('PASS — 没有标签页归属的消息不能广播');
  chrome.tabs.sendMessage=()=>Promise.reject(new Error('frame navigated'));
  assert.deepEqual(await send(false),{ok:false});
  console.log('PASS — 页面导航导致接收失败时正确回应且不抛异常');
  console.log('background-highlights-test: 5/5');
})().catch(error=>{console.error(error);process.exitCode=1});
