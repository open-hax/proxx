// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const workspace = path.resolve(__dirname, '../..');
// Deliberately synthetic test metadata; these values are never production authority.
const authority = { state: 'configured', appID: 700001, installationID: 700002,
  principal: { login: 'synthetic-kimi-fixture[bot]', id: 700003, type: 'Bot' }, repositoryID: 1178288746 };
const config = { authority, publicationRuntime: { sha: 'd'.repeat(40), reviewSHA256: 'a'.repeat(64),
  authSHA256: 'b'.repeat(64), authoritySHA256: 'c'.repeat(64) } };
/**
 * Compile a local auth test module with selected require substitutions and return its exports.
 */
function load(file, substitutes) {
  const m = new Module(file, module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
  const req=m.require.bind(m);m.require=n=>Object.hasOwn(substitutes,n)?substitutes[n]:req(n);
  m._compile(fs.readFileSync(file,'utf8'),file);return m.exports;
}
/**
 * Load the owned-token adapter with a synthetic authority registry, selected configuration and optional crypto substitution.
 */
function adapter(c = config, crypto) {
  const registry=load(path.join(__dirname,'opencode-app-auth.cjs'),{'./kimi-publication-authority.cjs':c.authority});
  return load(path.join(__dirname,'proxx-kimi-app-auth.cjs'),{'./kimi-publication-config.cjs':c,
    './opencode-app-auth.cjs':registry,...(crypto?{'node:crypto':crypto}:{})});
}
const lawPromise = require('./kimi-publisher.cjs').loadLaw(workspace);
/**
 * Build synthetic token-mint and revocation effects that record guard, key, signing, masking and request order without using live credentials.
 */
function fixture() {
  const f={calls:[],order:[],keyReads:0,signs:0,masked:[],now:2000000000};
  f.value={token:'synthetic-noncredential',expires_at:new Date((f.now+3600)*1000).toISOString(),
    permissions:{metadata:'read',pull_requests:'write'},repository_selection:'selected',
    repositories:[{id:1178288746,full_name:'open-hax/proxx',owner:{login:'open-hax'}}]};
  f.options=async()=>({core:{setSecret:x=>f.masked.push(x)},law:await lawPromise,
    preMint:async()=>{f.order.push('guard');if(f.guardFailure)throw Error('Synthetic guard refusal');},
    readKey:()=>{f.keyReads++;return 'synthetic-key-not-a-credential';},now:()=>f.now,
    sign:(id,key)=>{f.signs++;assert.equal(id,700001);assert.equal(key,'synthetic-key-not-a-credential');f.order.push('sign');return 'synthetic-jwt-not-a-credential';},
    fetchImpl:async(url,options)=>{f.calls.push({url,options});f.order.push(options.method);
      assert.equal(options.redirect,'error');assert.ok(options.signal);
      if(options.method==='POST')return{ok:!f.mintFailure,json:async()=>f.value};
      await Promise.resolve();f.order.push('revoked');return{status:f.revokeFailure?403:204};}});
  return f;
}
test('real null authority refuses before guard, key use, signing or HTTP',async()=>{
 const f=fixture();await assert.rejects(require('./proxx-kimi-app-auth.cjs').withOwnedKimiToken(await f.options(),async()=>assert.fail('use')));
 assert.deepEqual(f.order,[]);assert.equal(f.keyReads,0);assert.equal(f.signs,0);assert.equal(f.calls.length,0);
});
test('fresh guard precedes signing; exact scoped mint and awaited cleanup enclose use',async()=>{
 const f=fixture();const result=await adapter().withOwnedKimiToken(await f.options(),async token=>{
  assert.equal(token,'synthetic-noncredential');f.order.push('use');return 42;});
 assert.equal(result,42);assert.deepEqual(f.order,['guard','sign','POST','use','DELETE','revoked']);
 assert.equal(f.calls[0].url,'https://api.github.com/app/installations/700002/access_tokens');
 assert.deepEqual(JSON.parse(f.calls[0].options.body),{repository_ids:[1178288746],permissions:{metadata:'read',pull_requests:'write'}});
 assert.equal(f.calls[1].url,'https://api.github.com/installation/token');assert.equal(f.masked.length,2);
});
test('failed pre-mint guard never reads signer or mints',async()=>{
 const f=fixture();f.guardFailure=true;await assert.rejects(adapter().withOwnedKimiToken(await f.options(),async()=>assert.fail('use')));
 assert.equal(f.keyReads,0);assert.equal(f.calls.length,0);
});
for(const [name,mutate] of [
 ['MiMo actor ID',x=>x.authority.principal.id=270021952],['MiMo actor login',x=>x.authority.principal.login='eta-mu-ai[bot]'],
 ['foreign actor',x=>x.authority.principal.id=219766164],['generic actor',x=>x.authority.principal.login='github-actions[bot]'],
 ['missing App',x=>x.authority.appID=null],['missing installation',x=>x.authority.installationID=null],
 ['foreign installation',x=>x.authority.installationID=94995373],['missing helper pin',x=>x.publicationRuntime.sha=null],
 ['immutable281 as owned registry',x=>x.publicationRuntime.sha='2810f4515424a146fe37390fb0baf532cca31236']])
test(`authority rejects ${name} before effects`,async()=>{const c=structuredClone(config);mutate(c);const f=fixture();
 await assert.rejects(adapter(c).withOwnedKimiToken(await f.options(),async()=>assert.fail('use')));assert.equal(f.calls.length,0);assert.equal(f.keyReads,0);
});
for(const [name,mutate] of [
 ['extra permission',f=>f.value.permissions.issues='write'],['broad selection',f=>f.value.repository_selection='all'],
 ['foreign repository',f=>f.value.repositories[0].id=42],['extra repository',f=>f.value.repositories.push(f.value.repositories[0])],
 ['expired token',f=>f.value.expires_at=new Date(f.now*1000).toISOString()],['invalid expiry',f=>f.value.expires_at='UNKNOWN'],
 ['mint refused with known token',f=>f.mintFailure=true]])
test(`known minted token is revoked after ${name}; use refused`,async()=>{const f=fixture();mutate(f);
 await assert.rejects(adapter().withOwnedKimiToken(await f.options(),async()=>assert.fail('use')));
 assert.deepEqual(f.order,['guard','sign','POST','DELETE','revoked']);
});
test('callback and revoke failures aggregate sanitized errors and await cleanup',async()=>{
 const f=fixture();f.revokeFailure=true;
 await assert.rejects(adapter().withOwnedKimiToken(await f.options(),async()=>{throw Error('synthetic-noncredential');}),e=>{
  assert.ok(e instanceof AggregateError);assert.deepEqual(e.errors.map(x=>x.phase),['publication','revocation']);
  assert.doesNotMatch(String(e),/synthetic-noncredential/);return true;});assert.equal(f.order.at(-1),'revoked');
});
test('JWT claims are short, backdated, exact issuer and RS256 at the crypto edge',()=>{
 let signed;const auth=adapter(config,{sign:(algorithm,bytes,key)=>{signed={algorithm,bytes,key};return Buffer.from('synthetic-signature');}});
 const jwt=auth.signJWT(700001,'synthetic-key',2000000000),parts=jwt.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(parts[0],'base64url')),{alg:'RS256',typ:'JWT'});
 assert.deepEqual(JSON.parse(Buffer.from(parts[1],'base64url')),{iat:1999999940,exp:2000000540,iss:700001});
 assert.equal(signed.algorithm,'RSA-SHA256');assert.equal(signed.key,'synthetic-key');
});
