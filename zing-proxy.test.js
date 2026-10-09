import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createZingTransport, configureZingProxyClient, zingProxyEnabled } from './zing-proxy.js';

test('account session skips anonymous-cookie requests and any configured proxy',async()=>{
  const previousCookie=process.env.ZING_SESSION_COOKIE,previousProxy=process.env.ZING_PROXY_URL;
  process.env.ZING_SESSION_COOKIE='session=private-fixture';
  process.env.ZING_PROXY_URL='http://public-proxy.example:8080';
  try{
    const calls=[],client={CTIME:'123',VERSION:'test',API_KEY:'test'};
    assert.equal(zingProxyEnabled(),false);
    configureZingProxyClient(client,null,{fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});return Response.json({err:-1110,msg:'region restricted'});
    }});
    const result=await client.requestZingMp3('/api/v2/song/get/streaming',{id:'TEST123',sig:'test'});
    assert.equal(result.err,-1110); // Authentication must not conceal an upstream region restriction.
    assert.equal(calls.length,1);
    assert.equal(new URL(calls[0].url).hostname,'zingmp3.vn');
    assert.equal(calls[0].options.headers.Cookie,'session=private-fixture');
    assert.equal(calls[0].options.redirect,'error');
    assert.equal(calls[0].options.dispatcher,undefined);
    await assert.rejects(client.requestZingMp3('https://other.example/',{}),/Unsupported/);
    assert.equal(calls.length,1);
  }finally{
    if(previousCookie===undefined)delete process.env.ZING_SESSION_COOKIE;else process.env.ZING_SESSION_COOKIE=previousCookie;
    if(previousProxy===undefined)delete process.env.ZING_PROXY_URL;else process.env.ZING_PROXY_URL=previousProxy;
  }
});
test('account-session validation and transport failures keep the session secret',async()=>{
  const client={CTIME:'123',VERSION:'test',API_KEY:'test'};
  assert.throws(()=>configureZingProxyClient(client,null,{sessionCookie:'session=secret\r\nInjected: value'}),e=>!e.message.includes('secret'));
  configureZingProxyClient(client,null,{sessionCookie:'session=secret',fetchImpl:async()=>{throw Error('Cookie: session=secret');}});
  await assert.rejects(client.requestZingMp3('/api/v2/search/multi',{q:'test'}),e=>e.message==='Zing authenticated request failed');
});

test('proxy credentials are decoded and kept out of the endpoint URI',async()=>{
  let configuration;
  class Agent {constructor(value){configuration=value;}async close(){}}
  const transport=createZingTransport('http://test%40user:p%3Ass@proxy.example:8080',async(_url,options)=>{
    assert.ok(options.dispatcher instanceof Agent);return new Response('ok');
  },Agent);
  assert.equal(configuration.uri,'http://proxy.example:8080');
  assert.equal(configuration.token,'Basic '+Buffer.from('test@user:p:ss').toString('base64'));
  assert.equal(await (await transport.request('https://zingmp3.vn/')).text(),'ok');
  await transport.close();
});
test('invalid proxy configuration and request errors never echo credentials',async()=>{
  assert.throws(()=>createZingTransport('socks5://user:secret@proxy.example'),e=>!e.message.includes('secret'));
  class Agent {async close(){}}
  const transport=createZingTransport('http://user:secret@proxy.example',async()=>{throw Error('credential secret and URL should not be logged');},Agent);
  await assert.rejects(transport.request('https://zingmp3.vn/'),e=>e.message==='Zing proxy request failed: CONNECTION_FAILED');
});
test('Zing session and signed API requests share the proxy, with a short anonymous-cookie cache',async()=>{
  const calls=[],client={CTIME:'123',VERSION:'test',API_KEY:'test'};
  configureZingProxyClient(client,{async request(url,options){
    calls.push({url:String(url),options});
    return String(url)==='https://zingmp3.vn/'?new Response('',{headers:{'Set-Cookie':'anonymous=session; Path=/; Secure'}}):Response.json({err:0,data:{}});
  }});
  await client.requestZingMp3('/api/v2/search/multi',{q:'Sóng Gió',sig:'test'});
  await client.requestZingMp3('/api/v2/song/get/streaming',{id:'TEST123',sig:'test'});
  assert.equal(calls.length,3);
  assert.equal(new URL(calls[1].url).searchParams.get('ctime'),'123');
  assert.equal(calls[1].options.headers.Cookie,'anonymous=session');
  assert.equal(calls[2].options.headers.Cookie,'anonymous=session');
  await assert.rejects(client.requestZingMp3('/not-supported',{}),/Unsupported/);
});
test('real HTTP CONNECT failure is bounded and sanitized',async()=>{
  const server=http.createServer();let connects=0;
  server.on('connect',(req,socket)=>{
    connects++;assert.equal(req.url,'zingmp3.vn:443');
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const transport=createZingTransport('http://fake:secret@127.0.0.1:'+server.address().port);
  try{
    await assert.rejects(transport.request('https://zingmp3.vn/',{signal:AbortSignal.timeout(2000)}),e=>e.message.startsWith('Zing proxy request failed:') && !e.message.includes('secret'));
    assert.equal(connects,1);
  }finally{await transport.close();await new Promise(resolve=>server.close(resolve));}
});
