'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'blitz-data.json');
const TERMS_VERSION = '1.0';
const TERMS_TEXT = 'BLITZ LEGENDS ONLINE RULES\n\nBe respectful. Do not share passwords or recovery codes. Do not harass, threaten, or impersonate other players. Online play and cloud saves require a working game server. The server operator may remove abusive accounts. Never use a password you use for another account.';
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {}, saves: {}, rooms: {}, history: {}, fav: {}, friends: {}, blocks: {}, reports: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
let saveTimer;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); } catch (e) { console.error('Could not save database:', e.message); } }, 30); }
const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
const fail = (res, status, error, message) => res.status(status).json({ error, message });
const uid = () => crypto.randomBytes(16).toString('hex');
const code = (n=6) => crypto.randomBytes(8).toString('hex').slice(0,n).toUpperCase();
function hashPassword(pw, salt=crypto.randomBytes(16).toString('hex')) { return new Promise((resolve,reject)=>crypto.scrypt(String(pw), salt, 64, (e,k)=>e?reject(e):resolve({salt,hash:k.toString('hex')}))); }
async function checkPassword(pw, saved) { if (!saved) return false; const x = await hashPassword(pw, saved.salt); return crypto.timingSafeEqual(Buffer.from(x.hash,'hex'), Buffer.from(saved.hash,'hex')); }
function tokenFor(user, device) { const token = crypto.randomBytes(32).toString('hex'); db.sessions[token] = { uid:user.id, device: String(device||'').slice(0,80), created:Date.now() }; persist(); return token; }
function auth(req,res,next) { const h=String(req.headers.authorization||''); const tok=h.startsWith('Bearer ')?h.slice(7):''; const s=db.sessions[tok]; const u=s && Object.values(db.users).find(x=>x.id===s.uid); if(!u) return fail(res,401,'session_expired','Please sign in again.'); req.user=u; req.token=tok; next(); }
function publicUser(u) { return { uid:u.id, username:u.username, terms_ok:!!u.terms_ok, email:'', created_at:u.created_at }; }
function userByName(n) { return Object.values(db.users).find(u=>u.username.toLowerCase()===String(n||'').toLowerCase()); }
app.get('/api/health',(req,res)=>res.json({service:'blitz-legends',ok:true,version:'1.0',db:'up'}));
app.get('/api/terms',(req,res)=>res.json({version:TERMS_VERSION,text:TERMS_TEXT}));
app.post('/api/register', async (req,res)=>{ try { const {username,password,terms_version,device}=req.body||{}; if(!/^[A-Za-z0-9_]{3,16}$/.test(username||'')) return fail(res,400,'invalid_username','Username must be 3–16 letters, numbers, or underscores.'); if(userByName(username)) return fail(res,409,'username_taken','That username is already taken.'); if(String(password||'').length<8) return fail(res,400,'weak_password','Password must be at least 8 characters.'); if(terms_version!==TERMS_VERSION) return fail(res,400,'terms_required','Please reload and accept the current rules.'); const id=uid(), pw=await hashPassword(password), recovery_code=code(12); const u={id,username,password:pw,recovery_hash:crypto.createHash('sha256').update(recovery_code).digest('hex'),terms_ok:true,created_at:Date.now()}; db.users[id]=u; db.saves[id]={}; db.history[id]=[]; db.friends[id]=[]; db.blocks[id]=[]; const token=tokenFor(u,device); persist(); res.json({token,user:publicUser(u),recovery_code}); } catch(e){console.error(e);fail(res,500,'server_error','Server error.');} });
app.post('/api/login',async(req,res)=>{ const {username,password,device}=req.body||{}; const u=userByName(username); if(!u || !(await checkPassword(password,u.password))) return fail(res,401,'invalid_credentials','Username or password is incorrect.'); const token=tokenFor(u,device); res.json({token,user:publicUser(u)}); });
app.get('/api/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.post('/api/terms/accept',auth,(req,res)=>{ if(req.body?.version!==TERMS_VERSION)return fail(res,400,'terms_required','Please accept the current rules.');req.user.terms_ok=true;persist();res.json({ok:true});});
app.post('/api/logout',auth,(req,res)=>{ delete db.sessions[req.token]; persist(); res.json({ok:true}); });
app.get('/api/saves',auth,(req,res)=>res.json({saves:Object.entries(db.saves[req.user.id]||{}).map(([slot,v])=>({slot,data:v.data,version:v.version,updated_at:v.updated_at}))}));
app.put('/api/saves/:slot',auth,(req,res)=>{ const slot=String(req.params.slot||'').slice(0,100); if(!/^[A-Za-z0-9_.:-]+$/.test(slot))return fail(res,400,'invalid_slot','Invalid save slot.'); const data=req.body?.data; if(typeof data!=='string' || data.length>400000)return fail(res,400,'invalid_save','Save data must be text under 400 KB.'); const all=db.saves[req.user.id]||(db.saves[req.user.id]={}); const old=all[slot]; const base=Number(req.body?.base_version||0); if(old && base!==old.version)return res.status(409).json({error:'save_conflict',message:'This save changed on another device.',version:old.version}); const version=(old?.version||0)+1; all[slot]={data,version,updated_at:Date.now(),device:String(req.body?.device||'').slice(0,80)};persist();res.json({ok:true,version}); });
app.post('/api/saves/delete',auth,async(req,res)=>{if(!(await checkPassword(req.body?.password,req.user.password)))return fail(res,401,'invalid_credentials','Password is incorrect.');if(req.body?.confirm!==req.user.username)return fail(res,400,'confirmation_mismatch','Type your username to confirm.');db.saves[req.user.id]={};persist();res.json({ok:true});});
app.post('/api/password',auth,async(req,res)=>{if(!(await checkPassword(req.body?.old_password,req.user.password)))return fail(res,401,'invalid_credentials','Current password is incorrect.');if(String(req.body?.new_password||'').length<8)return fail(res,400,'weak_password','New password must be at least 8 characters.');req.user.password=await hashPassword(req.body.new_password);for(const [t,s] of Object.entries(db.sessions))if(s.uid===req.user.id)delete db.sessions[t];const token=tokenFor(req.user,'password-change');persist();res.json({ok:true,token});});
app.post('/api/recovery/regenerate',auth,async(req,res)=>{if(!(await checkPassword(req.body?.password,req.user.password)))return fail(res,401,'invalid_credentials','Password is incorrect.');const recovery_code=code(12);req.user.recovery_hash=crypto.createHash('sha256').update(recovery_code).digest('hex');persist();res.json({recovery_code});});
app.post('/api/recover',async(req,res)=>{const u=userByName(req.body?.username);const hash=crypto.createHash('sha256').update(String(req.body?.recovery_code||'')).digest('hex');if(!u||!u.recovery_hash||hash!==u.recovery_hash)return fail(res,401,'invalid_recovery_code','Recovery code is incorrect.');if(String(req.body?.new_password||'').length<8)return fail(res,400,'weak_password','Password must be at least 8 characters.');u.password=await hashPassword(req.body.new_password);const recovery_code=code(12);u.recovery_hash=crypto.createHash('sha256').update(recovery_code).digest('hex');for(const [t,s]of Object.entries(db.sessions))if(s.uid===u.id)delete db.sessions[t];persist();res.json({recovery_code});});
app.post('/api/account/delete',auth,async(req,res)=>{if(!(await checkPassword(req.body?.password,req.user.password)))return fail(res,401,'invalid_credentials','Password is incorrect.');if(req.body?.confirm!==req.user.username)return fail(res,400,'confirmation_mismatch','Type your username to confirm.');const id=req.user.id;delete db.users[id];delete db.saves[id];delete db.history[id];delete db.friends[id];delete db.blocks[id];for(const [t,s]of Object.entries(db.sessions))if(s.uid===id)delete db.sessions[t];persist();res.json({ok:true});});
app.get('/api/friends',auth,(req,res)=>res.json({friends:[],incoming:[],outgoing:[],blocks:(db.blocks[req.user.id]||[]).map(username=>({username}))}));
app.get('/api/profile',auth,(req,res)=>res.json({stats:{games:0,wins:0,losses:0,ties:0,pf:0,pa:0},fav_team:db.fav[req.user.id]||null,history:db.history[req.user.id]||[]}));
app.put('/api/profile/fav',auth,(req,res)=>{db.fav[req.user.id]=req.body?.team||null;persist();res.json({ok:true});});
app.post('/api/friends/request',auth,(req,res)=>res.json({result:'unavailable'}));
app.post('/api/friends/respond',auth,(req,res)=>res.json({ok:true}));
app.post('/api/block',auth,(req,res)=>{const n=String(req.body?.username||'').slice(0,16);db.blocks[req.user.id]=[...new Set([...(db.blocks[req.user.id]||[]),n])];persist();res.json({ok:true});});
app.post('/api/unblock',auth,(req,res)=>{db.blocks[req.user.id]=(db.blocks[req.user.id]||[]).filter(n=>n!==req.body?.username);persist();res.json({ok:true});});
app.post('/api/report',auth,(req,res)=>{db.reports.push({by:req.user.username,username:String(req.body?.username||'').slice(0,16),reason:String(req.body?.reason||'').slice(0,80),details:String(req.body?.details||'').slice(0,500),at:Date.now()});persist();res.json({ok:true});});
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'blitz-legends.html')));
app.use(express.static(__dirname,{index:false, dotfiles:'deny'}));
const server=http.createServer(app); const wss=new WebSocketServer({server,path:'/ws',maxPayload:256*1024});
const sockets=new Map(); const rooms=new Map(); const queues=[];
function send(ws,obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
function roomPublic(r){return {id:r.id,code:r.code,vis:r.vis,st:r.st,set:r.set,host:{name:r.host.name,team:r.host.team,ready:r.host.ready,on:!!r.host.ws},guest:r.guest?{name:r.guest.name,team:r.guest.team,ready:r.guest.ready,on:!!r.guest.ws}:null};}
function roomMsg(r){for(const p of [r.host,r.guest])if(p?.ws)send(p.ws,{t:'room',room:roomPublic(r),role:p.role});}
function err(ws,code,msg){send(ws,{t:'err',code,msg});}
function leave(ws,why='opponent_left'){const u=sockets.get(ws);if(!u)return;const r=u.room;if(r){if(r.startTimer){clearTimeout(r.startTimer);r.startTimer=null;}if(r.host?.ws===ws){if(r.guest){send(r.guest.ws,{t:'closed',why:'host_left'});const gu=sockets.get(r.guest.ws);if(gu)gu.room=null;}rooms.delete(r.id);}else if(r.guest?.ws===ws){r.guest=null;r.st='lobby';if(r.host.ws)send(r.host.ws,{t:'peer',on:false});roomMsg(r);}u.room=null;}sockets.delete(ws);}
function startRoom(r){r.st='loading';r.id=r.id||uid();const m={id:r.id,host:{lg:r.host.team.lg,i:r.host.team.i},guest:{lg:r.guest.team.lg,i:r.guest.team.i},set:r.set};send(r.host.ws,{t:'go',...m,role:'host',live:false});send(r.guest.ws,{t:'go',...m,role:'guest',live:false});roomMsg(r);}
function roomReady(r){
 if(!r)return;
 const ready=!!(r.host?.ready&&r.guest?.ready&&r.host.ws?.readyState===WebSocket.OPEN&&r.guest.ws?.readyState===WebSocket.OPEN);
 if(!ready){
  if(r.startTimer){clearTimeout(r.startTimer);r.startTimer=null;}
  if(r.st!=='lobby')r.st='lobby';
  roomMsg(r);return;
 }
 if(r.startTimer)return;
 r.st='countdown';
 send(r.host.ws,{t:'count',ms:3000});send(r.guest.ws,{t:'count',ms:3000});roomMsg(r);
 r.startTimer=setTimeout(()=>{
  r.startTimer=null;
  if(rooms.has(r.id)&&r.st==='countdown'&&r.host?.ready&&r.guest?.ready&&r.host.ws?.readyState===WebSocket.OPEN&&r.guest.ws?.readyState===WebSocket.OPEN)startRoom(r);
  else {r.st='lobby';roomMsg(r);}
 },3000);
}
wss.on('connection',(ws)=>{ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString());}catch{return err(ws,'bad_json','Invalid message.');}const u=sockets.get(ws);
 if(m.t==='auth'){const s=db.sessions[m.token],user=s&&Object.values(db.users).find(x=>x.id===s.uid);if(!user){send(ws,{t:'auth',ok:false,err:'bad_token'});return;}const old=[...sockets.entries()].find(([sock,x])=>x.user.id===user.id&&sock!==ws);if(old){send(old[0],{t:'closed',why:'signed_in_elsewhere'});leave(old[0],'signed_in_elsewhere');}sockets.set(ws,{user,ws,room:null,role:null});send(ws,{t:'auth',ok:true,name:user.username,role:'player'});return;}
 if(!u)return err(ws,'auth_required','Sign in first.');
 if(m.t==='ping'){send(ws,{t:'pong',ts:m.ts});return;}
 if(m.t==='create'){if(u.room)return err(ws,'already_in_room','Leave your current room first.');const id=uid(),r={id,code:code(5),vis:m.vis==='public'?'public':'private',st:'lobby',set:{q:300,time:'day',diff:1,chaos:1},host:{name:u.user.username,team:m.team||{lg:'nfl',i:0},ready:false,ws,role:'host'},guest:null,created:Date.now()};rooms.set(id,r);u.room=r;u.role='host';roomMsg(r);return;}
 if(m.t==='join'){const r=[...rooms.values()].find(x=>x.code===String(m.code||'').toUpperCase()&&x.st==='lobby'&&!x.guest);if(!r)return err(ws,'room_not_found','That room code is not available.');if(u.room)return err(ws,'already_in_room','Leave your current room first.');r.guest={name:u.user.username,team:m.team||{lg:'nfl',i:1},ready:false,ws,role:'guest'};u.room=r;u.role='guest';const gu=sockets.get(r.host.ws);if(gu)gu.room=r;roomMsg(r);send(r.host.ws,{t:'peer',on:true});return;}
 if(m.t==='list'){send(ws,{t:'list',rooms:[...rooms.values()].filter(r=>r.vis==='public'&&r.st==='lobby'&&!r.guest).map(r=>({code:r.code,host:r.host.name,team:r.host.team}))});return;}
 if(m.t==='quick'){const other=queues.find(x=>x!==u&&x.ws.readyState===WebSocket.OPEN&&!x.room);if(other){queues.splice(queues.indexOf(other),1);const id=uid(),r={id,code:code(5),vis:'public',st:'lobby',set:{q:300,time:'day',diff:1,chaos:1},host:{name:other.user.username,team:other.queueTeam||{lg:'nfl',i:0},ready:true,ws:other.ws,role:'host'},guest:{name:u.user.username,team:m.team||{lg:'nfl',i:1},ready:true,ws,role:'guest'}};rooms.set(id,r);other.room=r;other.role='host';u.room=r;u.role='guest';send(other.ws,{t:'matched',room:roomPublic(r),role:'host'});send(ws,{t:'matched',room:roomPublic(r),role:'guest'});roomReady(r);}else{u.queueTeam=m.team;queues.push(u);send(ws,{t:'queued'});setTimeout(()=>{const i=queues.indexOf(u);if(i>=0){queues.splice(i,1);send(ws,{t:'qtimeout'});}},45000);}return;}
 if(m.t==='qcancel'){const i=queues.indexOf(u);if(i>=0)queues.splice(i,1);send(ws,{t:'qcancelled'});return;}
 const r=u.room;if(!r)return err(ws,'not_in_room','You are not in a room.');const isHost=r.host?.ws===ws;const peer=isHost?r.guest:r.host;
 if(m.t==='team'){const p=r.host?.ws===ws?r.host:r.guest;p.team=m.team||p.team;roomMsg(r);return;}
 if(m.t==='settings'&&isHost&&r.st==='lobby'){r.set={...r.set,...m.set};r.host.ready=false;if(r.guest)r.guest.ready=false;roomMsg(r);return;}
 if(m.t==='ready'){if(r.st!=='lobby'&&r.st!=='countdown')return;const p=isHost?r.host:r.guest;if(!p)return;p.ready=!!m.on;roomReady(r);return;}
 if(m.t==='leave'){leave(ws);send(ws,{t:'closed',why:'host_left'});return;}
 if(m.t==='loaded'){if(peer?.ws)send(peer.ws,{t:'start'});return;}
 if(m.t==='rl'){if(peer?.ws)send(peer.ws,{t:'rl',d:m.d});return;}
 if(m.t==='sc'){if(peer?.ws)send(peer.ws,{t:'score',team:m.team,pts:m.pts});return;}
 if(m.t==='final'){const score=Array.isArray(m.score)?m.score:[0,0];const rec={id:r.id,at:Date.now(),me:score[0],opp:score[1],opp_name:peer?.name||'Opponent',won:score[0]===score[1]?-1:score[0]>score[1]?1:0,verified:false,reason:'final',recorded:false};for(const p of [r.host,r.guest])if(p){const h=db.history[Object.values(db.users).find(x=>x.username===p.name)?.id]||[];h.unshift({...rec,opp_name:p===r.host?r.guest?.name:r.host.name,me:p===r.host?score[0]:score[1],opp:p===r.host?score[1]:score[0],won:score[0]===score[1]?-1:((p===r.host?score[0]>score[1]:score[1]>score[0])?1:0)});if(h.length>25)h.length=25;const pu=Object.values(db.users).find(x=>x.username===p.name);if(pu)db.history[pu.id]=h;}persist();send(ws,{t:'result',...rec});if(peer?.ws)send(peer.ws,{t:'result',...rec,me:score[1],opp:score[0],won:score[0]===score[1]?-1:score[1]>score[0]?1:0});rooms.delete(r.id);return;}
 if(m.t==='invite'){err(ws,'feature_unavailable','Friend invites require the full social service. Share the room code instead.');return;}
 if(m.t==='friends_status'){send(ws,{t:'friends_status',list:[]});return;}
 });ws.on('close',()=>{leave(ws);});ws.on('error',()=>{});});
setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},25000);
server.listen(PORT,'0.0.0.0',()=>console.log(`Blitz Legends server listening on ${PORT}`));
