import http from 'node:http'; import fs from 'node:fs';
const OUT='/tmp/claude-1000/-home-admin-Projects-tern/75e5a84f-16a1-4b7d-8ba4-f4322d509671/scratchpad/wire2.log';
fs.writeFileSync(OUT,'');
http.createServer((req,res)=>{const ch=[];req.on('data',c=>ch.push(c));req.on('end',async()=>{const b=Buffer.concat(ch);
 if(req.url==='/api/chat') fs.appendFileSync(OUT,b.toString()+'\n');
 const up=await fetch('http://127.0.0.1:11435'+req.url,{method:req.method,headers:{'Content-Type':'application/json'},body:['GET','HEAD'].includes(req.method)?undefined:b});
 res.writeHead(up.status,{'Content-Type':up.headers.get('content-type')??'application/json'});
 if(up.body){const rd=up.body.getReader();for(;;){const{done,value}=await rd.read();if(done)break;res.write(value);}}
 res.end();});}).listen(11498,()=>console.log('tap on 11498'));
