'use strict';
// Native image encoding can outlive Chrome's virtual-time budget. Use wall time
// for these documents, with the same isolated Chrome profile and no dependencies.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async function runRealTime(name){
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mas-real-time-'));
 const url=new URL('file:///'+path.join(__dirname,name).replaceAll('\\','/')).href;
 const proc=spawn(process.env.MAS_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--allow-file-access-from-files',
  '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,url
 ],{windowsHide:true,stdio:'ignore'});
 let socket,exitError;
 const limit=setTimeout(()=>proc.kill(),35000);
 proc.on('error',error=>{exitError=error;});
 const pending=new Map();let sequence=0;
 try{
  const portFile=path.join(profile,'DevToolsActivePort'),deadline=Date.now()+30000;
  while(!fs.existsSync(portFile)&&Date.now()<deadline&&!exitError)await delay(50);
  if(exitError)throw exitError;
  const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
  let target;
  while(Date.now()<deadline){
   const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
   target=tabs.find(tab=>tab.type==='page'&&tab.url===url);
   if(target)break;await delay(50);
  }
  if(!target)throw new Error('Test document not found');
  socket=new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message',event=>{
   const message=JSON.parse(event.data),request=pending.get(message.id);
   if(request){clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}
  });
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const evaluate=expression=>new Promise((resolve,reject)=>{
   const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Chrome evaluation timed out'));},3000);
   pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
  });
  let result;
  while(Date.now()<deadline){
   const reply=await evaluate('({done:!!window.__TEST_DONE__,pass:document.querySelectorAll("#verdict .pass").length,fail:document.querySelectorAll("#verdict .fail").length,out:document.querySelector("#out")?.textContent})');
   result=reply.result?.value;
   if(result?.done)break;await delay(100);
  }
  console.log(`${name}: PASS=${result?.pass||0} FAIL=${result?.fail||0}`);
  const ok=!!result?.done&&result.pass>0&&result.fail===0;
  if(!ok)console.log(result?.out||'Test did not complete within 30 seconds.');
  return ok;
 }catch(error){console.error(name+': '+error.message);return false;}
 finally{clearTimeout(limit);for(const request of pending.values())clearTimeout(request.timer);socket?.close();proc.kill();}
};
