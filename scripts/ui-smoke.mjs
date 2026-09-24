// Test-only transport: browser -> actual Rust daemon. No terminal mocks.
import {chromium} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'vessel-ui-'));
const daemon=spawn('target/debug/vessel-daemon',[],{env:{...process.env,VESSEL_DATA_DIR:dir},stdio:'inherit'});
const vite=spawn('node',['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'pipe'});
let browser;
async function endpoint(){return JSON.parse(await readFile(join(dir,'endpoint.json'),'utf8'));}
async function rpc(request){const ep=await endpoint();return new Promise((resolve,reject)=>{const socket=net.connect(ep.port,'127.0.0.1');let output=Buffer.alloc(0);socket.on('error',reject);socket.on('connect',()=>{const body=Buffer.from(JSON.stringify({token:ep.token,request}));const len=Buffer.alloc(4);len.writeUInt32BE(body.length);socket.write(Buffer.concat([len,body]));});socket.on('data',data=>{output=Buffer.concat([output,data]);if(output.length>=5&&output.length>=5+output.readUInt32BE(1)){socket.end();const body=output.subarray(5);if(output[0])reject(Error(body.toString()));else resolve(request.op==='read'?Array.from(body):JSON.parse(body.toString()));}});socket.setTimeout(15000,()=>{socket.destroy();reject(Error('RPC timeout'));});});}
try{
 for(let i=0;i<100;i++){try{await endpoint();await fetch('http://127.0.0.1:1420');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:960},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__testInvoke',async(cmd,args)=>{
  if(cmd==='available_shells')return [{label:'System default',path:''}];
  return rpc(cmd==='rpc'?args.op:{op:'read',...args});
 });
 await page.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__testInvoke(cmd,args)};window.isTauri=true;});
 await page.goto('http://127.0.0.1:1420');await page.getByText('Local daemon connected').waitFor();await mkdir('docs/screenshots',{recursive:true});await page.screenshot({path:'docs/screenshots/welcome.png'});
 await page.getByRole('button',{name:'Create a workspace'}).click();await page.getByLabel('Name',{exact:true}).fill('Personal');await page.getByRole('button',{name:'Create workspace',exact:true}).click();
 await page.getByRole('button',{name:'Create your first session'}).click();await page.getByLabel('Name',{exact:true}).fill('Vessel development');await page.getByLabel('Repository or directory').fill(process.cwd());await page.getByRole('button',{name:'Create session',exact:true}).click();
 await page.getByRole('button',{name:'Open terminal'}).click();await page.locator('.terminal-instance.visible .xterm-helper-textarea').waitFor();
 const textarea=page.locator('.terminal-instance.visible .xterm-helper-textarea');await textarea.focus();await page.keyboard.type("printf 'VESSEL_%s\\n' READY");await page.keyboard.press('Enter');
 await page.waitForTimeout(500);let snapshot=await rpc({op:'snapshot'});const tid=snapshot.state.selectedTerminal;const screen=await rpc({op:'read',id:tid,cursor:null});assert(Buffer.from(screen.slice(10)).toString().includes('VESSEL_READY'));
 await page.getByRole('button',{name:'New terminal',exact:true}).click();await page.getByRole('tab').nth(1).waitFor();snapshot=await rpc({op:'snapshot'});assert.equal(snapshot.state.terminals.length,2);
 await page.getByRole('tab').first().dblclick();await page.getByLabel('Name',{exact:true}).fill('Development');await page.getByRole('button',{name:'Lilac',exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).click();await page.locator('#dialog-title').waitFor({state:'detached'});await page.getByRole('tab',{name:/Development/}).click();await page.screenshot({path:'docs/screenshots/terminal.png'});
 assert.equal((await rpc({op:'snapshot'})).state.terminals.find(t=>t.id===tid).color,'lilac');
 // Tiling: split twice. The stamps prove React never remounted the existing terminals,
 // which is what keeps their xterm instance and scrollback alive across a reshape.
 await page.evaluate(()=>document.querySelectorAll('.terminal-instance').forEach((el,i)=>{el.dataset.stamp='pane'+i;}));
 const stampedBefore=await page.locator('.terminal-instance').count();
 const openMenu=async(item)=>{await page.getByRole('button',{name:'Session and terminal actions'}).click();await page.getByRole('menuitem',{name:item,exact:true}).click();};
 await openMenu('Split right');
 await page.locator('.pane-divider').first().waitFor();
 await openMenu('Split down');
 await page.waitForFunction(()=>document.querySelectorAll('.pane-divider').length===2);
 const rects=await page.locator('.terminal-instance.visible').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
 assert.equal(rects.length,3,`expected 3 panes, got ${rects.length}`);
 for(const[i,a]of rects.entries())for(const b of rects.slice(i+1)){
  const overlap=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  assert.ok(overlap<2,`panes overlap by ${overlap}`);
 }
 const stamps=await page.locator('.terminal-instance').evaluateAll(els=>els.map(e=>e.dataset.stamp??null).filter(Boolean));
 assert.equal(stamps.length,stampedBefore,'a terminal was remounted by the split, which destroys its scrollback');
 const liveBuffer=await rpc({op:'read',id:tid,cursor:null});
 assert.ok(Buffer.from(liveBuffer.slice(10)).toString().includes('VESSEL_READY'),'the split terminal lost its screen');
 await page.screenshot({path:'docs/screenshots/split-nested.png'});
 // Dragging a divider persists the new proportions.
 const devSession=(await rpc({op:'snapshot'})).state.sessions.find(s=>s.name==='Development'||s.name==='Vessel development');
 const evenly=(await rpc({op:'snapshot'})).state.sessions.find(s=>s.id===devSession.id).layout.root;
 assert.equal(evenly.children[0].size,evenly.children[1].size);
 const handle=await page.locator('.pane-divider.row').first().boundingBox();
 // Grab away from mid-height: the horizontal divider of the nested split crosses there.
 const grabY=handle.y+handle.height/4;
 await page.mouse.move(handle.x+handle.width/2,grabY);
 await page.mouse.down();
 await page.mouse.move(handle.x+handle.width/2-140,grabY,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(400);
 const dragged=(await rpc({op:'snapshot'})).state.sessions.find(s=>s.id===devSession.id).layout.root;
 assert.ok(dragged.children[0].size<evenly.children[0].size,`divider drag did not persist: ${JSON.stringify(dragged.children.map(c=>c.size))}`);
 // Back to tabs so the rest of the run sees a single pane.
 await openMenu('Show as tabs');
 await page.waitForFunction(()=>document.querySelectorAll('.pane-divider').length===0);
 const before=await rpc({op:'snapshot'});await page.reload();await page.getByRole('tab',{name:/Development/}).waitFor();const after=await rpc({op:'snapshot'});assert.equal(before.statuses[tid].pid,after.statuses[tid].pid);
 assert.equal(await page.locator('.breadcrumb, .context-bar').count(),0);
 await page.getByRole('button',{name:'Session and terminal actions'}).click();
 await page.getByRole('menuitem',{name:'Rename session',exact:true}).waitFor();
 await page.getByRole('menuitem',{name:'Rename terminal',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 // Exercise real directory autocomplete and automatic Git detection.
 const repo=join(dir,'project alpha');await mkdir(repo);
 const git=(args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
 git(['init']);git(['-c','user.name=Test','-c','user.email=test@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial']);
 const worktree=join(dir,'existing worktree');git(['worktree','add','-b','feature/existing',worktree]);
 await page.getByRole('button',{name:'New session',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('Worktree session');
 const pathInput=page.getByRole('combobox',{name:'Repository or directory'});
 await pathInput.fill(join(dir,'project'));
 await page.getByRole('option',{name:'project alpha'}).waitFor();
 await page.screenshot({path:'docs/screenshots/directory-autocomplete.png'});
 await pathInput.press('Tab');assert.equal(await pathInput.inputValue(),repo+'/');
 await page.getByRole('radio',{name:/Existing worktree Pick up work/}).check();
 await page.getByRole('radio',{name:/feature\/existing/}).check();
 await page.screenshot({path:'docs/screenshots/session-worktree.png'});
 await page.getByRole('button',{name:'Create session',exact:true}).click();
 let created=await rpc({op:'snapshot'});assert(created.state.sessions.some(s=>s.name==='Worktree session'&&s.cwd.endsWith('existing worktree')));
 await page.getByRole('button',{name:'New session',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('New worktree session');
 await page.getByRole('combobox',{name:'Repository or directory'}).fill(repo);
 await page.getByRole('radio',{name:/New worktree Isolate a task/}).check();
 await page.getByLabel('Branch',{exact:true}).fill('feature/new');
 await page.getByRole('combobox',{name:'New worktree location'}).fill(join(dir,'new worktree'));
 await page.getByLabel('Name',{exact:true}).click();
 await page.screenshot({path:'docs/screenshots/session-new-worktree.png'});
 await page.getByRole('button',{name:'Create session',exact:true}).click();
 created=await rpc({op:'snapshot'});assert(created.state.sessions.some(s=>s.name==='New worktree session'&&s.branch==='feature/new'));
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Deep Sea',exact:true}).click();await page.getByRole('button',{name:'Save preferences'}).click();await page.getByText('Settings saved').waitFor();assert.equal((await rpc({op:'snapshot'})).config.theme,'Deep Sea');await page.screenshot({path:'docs/screenshots/settings.png'});
 await page.getByRole('button',{name:'Shell',exact:true}).click();
 const shellSelect=page.getByRole('combobox',{name:'Shell for new terminals'});await shellSelect.waitFor();
 assert.equal(await shellSelect.evaluate(el=>getComputedStyle(el).appearance),'none');
 assert.equal(await shellSelect.evaluate(el=>el.parentElement.className),'select');
 await page.getByRole('button',{name:'Terminal',exact:true}).click();
 await page.getByLabel('Copy wrapped rows as whole lines').check();
 await page.getByRole('button',{name:'Sounds',exact:true}).click();
 await page.getByLabel('Play a sound when a command finishes').check();
 await page.getByLabel('Completion sound').selectOption('Ping');
 await page.getByLabel('Wait between sounds (seconds)').fill('45');
 await page.getByRole('button',{name:'Play sound'}).click();
 await page.getByRole('button',{name:'Notifications',exact:true}).click();
 await page.getByLabel('Ignore commands shorter than (seconds)').fill('0');
 await page.getByRole('button',{name:'Save preferences'}).click();await page.getByText('Settings saved').waitFor();
 const sounds=(await rpc({op:'snapshot'})).config;
 assert.equal(sounds.soundEnabled,true);assert.equal(sounds.soundName,'Ping');assert.equal(sounds.notifyAfterSeconds,0);assert.equal(sounds.copyJoinWrapped,true);assert.equal(sounds.soundCooldownSeconds,45);
 await page.getByRole('button',{name:'Appearance',exact:true}).click();
 await page.getByRole('button',{name:'Find a command'}).click();await page.getByPlaceholder('What would you like to do?').fill('rename');await page.screenshot({path:'docs/screenshots/palette.png'});await page.keyboard.press('Escape');
 // Quick session skips the dialog entirely and lands in the home directory with a terminal open.
 await page.getByRole('button',{name:'Quick session',exact:true}).click();
 await page.getByRole('tab',{name:/Shell/}).first().waitFor();
 const quick=(await rpc({op:'snapshot'})).state.sessions.find(s=>s.name==='Quick session');
 assert(quick,'quick session was not created');
 assert.equal(quick.cwd,homedir());
 assert.equal(quick.worktree,null);
 assert((await rpc({op:'snapshot'})).state.terminals.some(t=>t.sessionId===quick.id),'quick session opened no terminal');
 // A command finishing where nobody is looking marks the session that holds it, and the
 // mark clears once that terminal is on screen.
 const elsewhere=(await rpc({op:'snapshot'})).state.terminals.find(t=>t.sessionId!==quick.id);
 const older=page.locator('.session-item',{hasText:'Vessel development'});
 await rpc({op:'input',id:elsewhere.id,data:'sleep 1\r'});
 await older.locator('.attention-dot').waitFor();
 await older.locator('button').first().click();
 await page.getByRole('tab',{name:new RegExp(elsewhere.name)}).click();
 await older.locator('.attention-dot').waitFor({state:'detached'});
 // Session deletion removes the session and its terminals, leaving the directory on disk.
 const doomed=(await rpc({op:'snapshot'})).state.sessions.find(s=>s.name==='Quick session');
 await page.getByRole('button',{name:`Delete session ${doomed.name}`}).click();
 await page.getByRole('button',{name:'Delete session',exact:true}).click();
 await page.getByRole('button',{name:`Delete session ${doomed.name}`}).waitFor({state:'detached'});
 const afterSession=await rpc({op:'snapshot'});
 assert(!afterSession.state.sessions.some(s=>s.id===doomed.id));
 assert(afterSession.state.terminals.every(t=>t.sessionId!==doomed.id));
 assert(afterSession.state.selectedSession,'selection went empty after deleting a session');
 // Workspace deletion takes the workspace and its sessions with it.
 await page.getByRole('button',{name:'New workspace'}).click();await page.getByLabel('Name',{exact:true}).fill('Scratch');await page.getByRole('button',{name:'Create workspace',exact:true}).click();
 const scratch=(await rpc({op:'snapshot'})).state.workspaces.find(w=>w.name==='Scratch');assert(scratch);
 await page.locator('.workspace-tab',{hasText:'Scratch'}).locator('button').first().dblclick();
 await page.getByRole('button',{name:'Rose',exact:true}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.locator('#dialog-title').waitFor({state:'detached'});
 assert.equal((await rpc({op:'snapshot'})).state.workspaces.find(w=>w.id===scratch.id).color,'rose');
 await page.getByRole('button',{name:'Delete workspace Scratch'}).click();
 await page.getByRole('button',{name:'Delete workspace',exact:true}).click();
 await page.getByRole('button',{name:'Delete workspace Scratch'}).waitFor({state:'detached'});
 const pruned=await rpc({op:'snapshot'});
 assert(!pruned.state.workspaces.some(w=>w.id===scratch.id));
 assert(pruned.state.sessions.every(s=>s.workspaceId!==scratch.id));
 assert.deepEqual(errors,[]);console.log('PASS: UI creation, real PTY input, multiple terminals, rename, reload persistence, settings, palette, consolidated menu, directory autocomplete, existing/new worktree selection, styled selects, quick session, entity colors, nested tiling without remounts, divider drag, event sound settings, wrapped-copy setting, finished-command marks, session deletion, workspace deletion.');
}finally{try{const s=await rpc({op:'snapshot'});for(const t of s.state.terminals)await rpc({op:'closeTerminal',id:t.id});}catch{}await browser?.close();daemon.kill();vite.kill();await rm(dir,{recursive:true,force:true});}
