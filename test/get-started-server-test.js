'use strict';
// Real local POST navigation: old content-script contexts are destroyed by Chrome.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const posts = [];
const harness = `<!doctype html><meta charset="utf-8"><title>Get Started native POST resume</title>
<div id="verdict">Running</div><pre id="out"></pre>
<script>
const cases={auto:{},highlight:{},select:{},chapter:{}};
for(const c of Object.values(cases))Object.assign(c,{session:null,api:0,loads:[],begins:0,entrySaved:false,questionSaved:false,manualStarts:0,shortcutStarts:0});
window.bridge=function(win,name,phase){
 const c=cases[name],listeners=[];win.__testListeners=listeners;c.loads.push(phase);c.win=win;
 if(phase==='intro')win.document.querySelector('main button[aria-label="Get Started"]').addEventListener('click',()=>{
  c.detected=win.__MCQ_DEBUG__.findAdvanceButton(null)?.el.matches('main button[aria-label="Get Started"]');
 });
 return {runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage(msg,cb){
  let r={ok:true};
  if(msg.type==='MCQ_SESSION_GET')r={ok:true,session:c.session?.active?structuredClone(c.session):null};
  if(msg.type==='MCQ_SESSION_BEGIN'){c.begins++;c.session={active:true,kind:msg.payload?.kind||'auto',done:[]};r.session=c.session}
  if(msg.type==='MCQ_SESSION_PROGRESS'){
   if(!c.session)c.session={active:true,kind:'auto',done:[]};
   c.session.done=[...new Set([...c.session.done,...msg.payload.done])];r.session=c.session;
  }
  if(msg.type==='MCQ_SESSION_END')c.session=null;
  if(msg.type==='MCQ_SOLVE'){c.api++;r={ok:true,letters:['B'],confidence:1,reason:'local test'}}
  if(cb)cb(r);return Promise.resolve(r);
 }},storage:{local:{get:async()=>({mcqSettings:{apiKey:'fake',mode:name==='select'?'select':'submit',actionDelay:0,submitDelay:0,pageTimeout:1500,concurrency:1}})}}};
};
window.record=function(win,name,phase){
 const c=cases[name];c.win=win;
 if(phase==='review'){
  c.reviewDetected=win.__MCQ_DEBUG__.findAdvanceButton(null)?.el.id==='next-page';
  c.quizClicks=0;
  win.document.getElementById('next-page').addEventListener('click',()=>{c.quizClicks++;c.reviewSaved=!!c.session?.active});
  win.document.querySelectorAll('.reading-activity a').forEach(el=>el.onclick=()=>c.wrongActivity=true);
  win.document.querySelector('[aria-label^="Go to Previous Content"]').onclick=()=>c.wrongPrevious=true;
  c.manualStarts++;win.__testListeners[0]({type:'MCQ_START'},{},()=>{});
 }
 if(phase==='intro'){
  c.detected=win.__MCQ_DEBUG__.findAdvanceButton(null)?.el.matches('main button[aria-label="Get Started"]');
  win.document.querySelector('form').addEventListener('submit',()=>{c.entrySaved=!!c.session?.active;c.entryKind=c.session?.kind});
  win.document.getElementById('nav-start').onclick=()=>c.wrongNav=true;
  win.document.getElementById('nav-next').onclick=()=>c.wrongNav=true;
  if(name==='highlight'){c.shortcutStarts++;win.document.dispatchEvent(new win.KeyboardEvent('keydown',{key:'p',code:'KeyP',ctrlKey:true,altKey:true,bubbles:true}))}
  else if(name!=='chapter'){c.manualStarts++;win.__testListeners[0]({type:'MCQ_START'},{},()=>{})}
 }
 if(phase==='question')win.document.querySelector('form').addEventListener('submit',()=>c.questionSaved=!!c.session?.done.length);
};
for(const name of Object.keys(cases)){
 const frame=document.createElement('iframe');frame.id=name;frame.src=(name==='chapter'?'/review':'/intro')+'?case='+name;document.body.appendChild(frame);
}
(async()=>{
 const deadline=performance.now()+23000;
 while(performance.now()<deadline){
  if(cases.auto.loads.includes('finish')&&!cases.auto.session&&cases.highlight.win?.document.querySelector('.__mcq_pick')&&!cases.highlight.session&&cases.select.win?.document.querySelector('input:checked')&&!cases.select.win.__MCQ_DEBUG__.state.running&&cases.chapter.loads.includes('finish')&&!cases.chapter.session)break;
  await new Promise(r=>setTimeout(r,100));
 }
 const checks=[],check=(n,ok)=>checks.push([n,!!ok]),a=cases.auto,h=cases.highlight,s=cases.select,c=cases.chapter;
 check('三种模式都优先识别真实Get Started表单按钮',Object.values(cases).every(c=>c.detected));
 check('导航栏同名按钮和Next从未误点',Object.values(cases).every(c=>!c.wrongNav));
 check('普通自动模式仅手动开始一次即可经过真实刷新',a.manualStarts===1&&a.loads.join(',')==='intro,question,finish');
 check('普通模式在入口POST前已持久化会话',a.entrySaved&&a.entryKind==='auto');
 check('新题页无需再次开始便求解且仅调用一次模型',a.api===1);
 check('普通模式提交答案前已持久化题目hash',a.questionSaved);
 check('普通模式完成后结束会话',!a.session&&a.loads.includes('finish'));
 check('快捷键只需按一次就进入并刷新到题目页',h.shortcutStarts===1&&h.manualStarts===0&&h.loads.join(',')==='intro,question');
 check('快捷键在入口POST前保存独立highlight类型',h.entrySaved&&h.entryKind==='highlight');
 check('快捷键新文档自动求解，无需再次启动插件',h.api===1&&!!h.win.document.querySelector('.__mcq_pick'));
 check('快捷键恢复不会按保存的submit模式勾选或提交',!h.win.document.querySelector('input:checked')&&h.loads.length===2);
 check('快捷键刷新后高亮默认隐藏且无悬浮窗口',!h.win.document.documentElement.classList.contains('__mas_answers_visible')&&!h.win.document.getElementById('__mcq_panel_host'));
 check('高亮恢复完成后清理一次性进入会话',!h.session);
 h.win.document.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'p',code:'KeyP',ctrlKey:true,altKey:true,bubbles:true}));
 check('恢复后按住原快捷键即可显示答案',getComputedStyle(h.win.document.querySelector('.__mcq_pick')).outlineStyle==='solid');
 h.win.document.dispatchEvent(new h.win.KeyboardEvent('keyup',{key:'p',code:'KeyP',ctrlKey:true,altKey:true,bubbles:true}));
 check('松开后仍立即隐藏',getComputedStyle(h.win.document.querySelector('.__mcq_pick')).outlineStyle!=='solid');
 check('仅选中模式也能自动进入并在刷新后选择答案',s.loads.join(',')==='intro,question'&&s.api===1&&s.win.document.querySelector('input:checked')?.value==='B');
 check('仅选中模式恢复后不提交',!s.session&&s.loads.length===2);
 const native=await(await fetch('/server-stats')).json();
 check('所有Get Started均为真实POST，保留验证字段',native.filter(p=>p.path==='/enter').length===4&&native.filter(p=>p.path==='/enter').every(p=>p.body.includes('__RequestVerificationToken=local-fixture-token')));
 check('仅自动提交模式发送答题POST且答案正确',native.filter(p=>p.path==='/finish').length===2&&native.filter(p=>p.path==='/finish').every(p=>p.body.includes('answer=B')));
 check('In Review选择正文Next Chapter Quiz并在点击前保存会话',c.reviewDetected&&c.reviewSaved);
 check('真实GET跳转后继续Get Started和答题POST',c.loads.join(',')==='review,intro,question,finish');
 check('不会回到活动或上一节形成循环',!c.wrongActivity&&!c.wrongPrevious&&c.quizClicks===1);
 check('跨阅读页及测验页只启动一次且仅求解一次',c.manualStarts===1&&c.api===1);
 check('章末导航完成后正常清理会话',!c.session&&!native.some(p=>p.path==='/activity'||p.path==='/previous'));
 document.getElementById('verdict').innerHTML=checks.map(([n,ok])=>'<div class="'+(ok?'pass':'fail')+'">'+(ok?'PASS':'FAIL')+' — '+n+'</div>').join('');
 const summary=Object.fromEntries(Object.entries(cases).map(([n,c])=>[n,{loads:c.loads,api:c.api,entryKind:c.entryKind,session:c.session}]));
 document.getElementById('out').textContent=JSON.stringify({checks,cases:summary,posts:native},null,2);
})();
</script>`;

function documentHtml(name, phase) {
  let markup;
  if(phase==='review'){
    markup=fs.readFileSync(path.join(__dirname,'sage-chapter-quiz-fixture.html'),'utf8').replace(/href="([^"]*)"/g,(_,href)=>{
      const url=new URL(href);
      const route=url.hash?'/review':url.pathname.includes('/cq-7-')?'/intro':url.pathname.includes('/ra-7-')?'/activity':'/previous';
      return 'href="'+route+'?case=chapter'+url.hash+'"';
    });
  }
  else if (phase === 'intro') markup=fs.readFileSync(path.join(__dirname,'sage-start-fixture.html'),'utf8').replace('action="/enter"',`action="/enter?case=${name}"`);
  else if (phase === 'question') markup=`<main><form method="post" action="/finish?case=${name}"><fieldset><legend>Which number equals two plus two?</legend>${['3','4','5','6'].map((text,i)=>`<label><input type="radio" name="answer" value="${'ABCD'[i]}">${text}</label>`).join('')}</fieldset><button type="submit">Submit</button></form></main>`;
  else markup='<main>Finished</main>';
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/content/overlay.css"><style>label{display:block;margin:8px}body{font:14px sans-serif}</style>${markup}<script>window.chrome=parent.bridge(window,${JSON.stringify(name)},${JSON.stringify(phase)});</script><script src="/content/detector.js"></script><script src="/content/solver.js"></script><script>parent.record(window,${JSON.stringify(name)},${JSON.stringify(phase)});</script>`;
}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/server-stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(posts));return}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(harness);return}
  if(['/review','/activity','/previous','/intro','/enter','/finish'].includes(url.pathname)){
    const name=url.searchParams.get('case');
    if(!['auto','highlight','select','chapter'].includes(name)){res.writeHead(400);res.end();return}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      if(req.method==='POST'||['/activity','/previous'].includes(url.pathname))posts.push({path:url.pathname,name,body});
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(documentHtml(name,['/review','/activity','/previous'].includes(url.pathname)?'review':url.pathname==='/intro'?'intro':url.pathname==='/enter'?'question':'finish'));
    });return;
  }
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
server.listen(0,'127.0.0.1',()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mas-native-start-'));
  const chrome=process.env.MAS_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-gpu-compositing','--disable-features=Vulkan,Dawn,UseSkiaRenderer','--use-angle=swiftshader','--use-gl=swiftshader','--no-first-run','--user-data-dir='+profile,'--virtual-time-budget=26000','--dump-dom','http://127.0.0.1:'+server.address().port+'/'],{windowsHide:true});
  let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
  const timeout=setTimeout(()=>child.kill(),45000);
  child.on('error',error=>{console.error(error);clearTimeout(timeout);server.close();process.exitCode=1});
  child.on('close',code=>{
    clearTimeout(timeout);server.close();
    const pass=(output.match(/<div class="pass">PASS/g)||[]).length,fail=(output.match(/<div class="fail">FAIL/g)||[]).length;
    console.log('get-started-server-test: PASS='+pass+' FAIL='+fail);
    if(code!==0||fail||pass!==24){console.log(output.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1]||output.slice(-3000)||errors.slice(-2000));process.exitCode=1}
  });
});
