'use strict';
// Runs isolated, local test documents. All API responses in the fixtures are stubs.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const names=process.argv.slice(2);
const files=names.length?names:fs.readdirSync(__dirname).filter(n=>n.endsWith('-test.html'));
async function run(name){
 if(name==='vision-capture-fallback-test.html')return require('./run-real-time-test')(name);
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mas-regression-'));
 const args=['--headless=new','--no-sandbox','--disable-gpu','--disable-gpu-compositing','--disable-features=Vulkan,Dawn,UseSkiaRenderer','--use-angle=swiftshader','--use-gl=swiftshader','--no-first-run','--allow-file-access-from-files','--user-data-dir='+profile,'--virtual-time-budget=50000','--dump-dom',new URL('file:///'+path.join(__dirname,name).replaceAll('\\','/')).href];
 return new Promise(resolve=>{
  const proc=spawn(process.env.MAS_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',args,{windowsHide:true});
  let output='',errors='';proc.stdout.on('data',d=>output+=d);proc.stderr.on('data',d=>errors+=d);
  const timer=setTimeout(()=>proc.kill(),60000);
  proc.on('error',e=>{clearTimeout(timer);console.error(e);resolve(false)});
  proc.on('close',code=>{
   clearTimeout(timer);
   const pass=(output.match(/<div class="pass">PASS/g)||[]).length,fail=(output.match(/<div class="fail">FAIL/g)||[]).length;
   console.log(`${name}: PASS=${pass} FAIL=${fail}`);
   if(code!==0||!pass||fail)console.log(output.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1]||output.slice(-3000)||errors.slice(-1000));
   resolve(code===0&&pass>0&&fail===0);
  });
 });
}
(async()=>{let ok=true;for(const file of files)ok=(await run(file))&&ok;if(!ok)process.exitCode=1})();
