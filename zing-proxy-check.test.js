import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkZingProxy, runProxyChecks } from './zing-proxy-check.js';

test('a proxy that accepts CONNECT then stalls is stopped by the overall deadline',async()=>{
  const server=http.createServer();
  const sockets=new Set();
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  server.on('connect',(_req,s)=>s.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const start=Date.now();
    const result=await checkZingProxy('http://127.0.0.1:'+server.address().port,100);
    assert.equal(result.playable,false);
    assert.equal(result.error,'PROXY_CHECK_TIMEOUT');
    assert.ok(Date.now()-start<2000);
  } finally {
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }
});
test('diagnostics reject credentials and oversized batches before connecting',async()=>{
  await assert.rejects(runProxyChecks('http://user:secret@127.0.0.1:1'),/without credentials/);
  await assert.rejects(runProxyChecks(Array.from({length:21},(_,i)=>'http://127.0.0.1:'+(1000+i)).join(',')),/At most 20/);
});
