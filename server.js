// AFTER THE STORM — multiplayer server. No dependencies: `node server.js`
// Also serves the game itself if After_the_Storm_Night_Hunter.html (or index.html) sits next to this file.
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const PORT=process.env.PORT||8080,MAX=8,GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const GAME=['After_the_Storm_Night_Hunter.html','index.html'].map(f=>path.join(__dirname,f)).find(f=>fs.existsSync(f));
const srv=http.createServer((req,res)=>{
  if((req.url==='/'||req.url.startsWith('/?'))&&GAME){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(GAME).pipe(res)}
  else{res.writeHead(200,{'Content-Type':'text/plain'});res.end('After the Storm server is running.\n')}});
const rooms=new Map();let nid=1;
function frame(op,buf){const n=buf.length;let h;if(n<126)h=Buffer.from([0x80|op,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x80|op;h[1]=126;h.writeUInt16BE(n,2)}else{h=Buffer.alloc(10);h[0]=0x80|op;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}return Buffer.concat([h,buf])}
const send=(c,o)=>{if(c.sock.writable)c.sock.write(frame(1,Buffer.from(JSON.stringify(o))))};
const others=(c,o)=>{if(c.room)for(const p of c.room.players.values())if(p!==c)send(p,o)};
const num=v=>Number.isFinite(+v)?+v:0;
const clean=(s,n)=>String(s==null?'':s).replace(/[^\w \-.!?,']/g,'').trim().slice(0,n);
function onMsg(c,m){
  if(m.t==='j'&&!c.room){
    const code=clean(m.r,8).toUpperCase().replace(/\s/g,'')||'MAIN';let r=rooms.get(code);
    if(!r){if(rooms.size>=200)return send(c,{t:'x',m:'Server busy'});r={code,players:new Map(),host:null};rooms.set(code,r)}
    if(r.players.size>=MAX)return send(c,{t:'x',m:'Room full'});
    c.name=clean(m.n,16)||'Survivor'+c.id;c.room=r;
    const list=[...r.players.values()].map(p=>({id:p.id,name:p.name}));
    r.players.set(c.id,c);if(!r.host)r.host=c.id;
    send(c,{t:'w',id:c.id,host:r.host,room:code,players:list});others(c,{t:'j',id:c.id,name:c.name});return}
  if(!c.room)return;
  if(m.t==='s'){const o={t:'s',id:c.id,x:num(m.x),y:num(m.y),z:num(m.z),h:num(m.h),v:num(m.v)};
    if(m.hn&&typeof m.hn==='object')o.hn={x:num(m.hn.x),y:num(m.hn.y),z:num(m.hn.z),h:num(m.hn.h),v:num(m.hn.v),f:num(m.hn.f)};others(c,o)}
  else if(m.t==='c'){const t=clean(m.m,120);if(t){const o={t:'c',id:c.id,n:c.name,m:t};for(const p of c.room.players.values())send(p,o)}}
  else if(m.t==='e'&&c.room.host===c.id)others(c,{t:'e',d:num(m.d),w:clean(m.w,10)});
  else if(m.t==='d')others(c,{t:'d',id:c.id,n:c.name})}
function drop(c){if(c.gone)return;c.gone=true;const r=c.room;if(r){r.players.delete(c.id);others({room:r},{t:'l',id:c.id,n:c.name});
  if(r.host===c.id){const n=r.players.values().next().value;r.host=n?n.id:null;if(n)for(const p of r.players.values())send(p,{t:'h',id:n.id})}
  if(!r.players.size)rooms.delete(r.code)}try{c.sock.destroy()}catch(e){}}
srv.on('upgrade',(req,sock)=>{
  const k=req.headers['sec-websocket-key'];if(!k){sock.destroy();return}
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(k+GUID).digest('base64')+'\r\n\r\n');
  const c={sock,id:nid++,room:null,name:'',alive:true,n:0,t0:Date.now()};let buf=Buffer.alloc(0);
  sock.on('data',d=>{buf=Buffer.concat([buf,d]);
    for(;;){if(buf.length<2)return;const op=buf[0]&15,mk=buf[1]&128;let len=buf[1]&127,off=2;
      if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4}else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10}
      if(len>8192||!mk)return drop(c);if(buf.length<off+4+len)return;
      const mask=buf.slice(off,off+4),p=Buffer.from(buf.slice(off+4,off+4+len));for(let i=0;i<len;i++)p[i]^=mask[i&3];buf=buf.slice(off+4+len);
      if(op===8)return drop(c);if(op===9){sock.write(frame(10,p));continue}if(op===10){c.alive=true;continue}
      if(op===1){const now=Date.now();if(now-c.t0>1000){c.t0=now;c.n=0}if(++c.n>60)continue;let m;try{m=JSON.parse(p.toString())}catch(e){continue}if(m&&typeof m==='object')onMsg(c,m)}}});
  sock.on('close',()=>drop(c));sock.on('error',()=>drop(c));c.ping=()=>{if(!c.alive)return drop(c);c.alive=false;if(sock.writable)sock.write(frame(9,Buffer.alloc(0)))};
  srv.clients=srv.clients||new Set();srv.clients.add(c);sock.on('close',()=>srv.clients.delete(c))});
setInterval(()=>{if(srv.clients)for(const c of srv.clients)c.ping()},25000);
srv.listen(PORT,()=>console.log('After the Storm server listening on :'+PORT+(GAME?' (serving '+path.basename(GAME)+')':'')));
