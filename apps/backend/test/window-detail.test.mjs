// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {request} from "node:http";
import {startBackend} from "../../../out/backend/server.js";
import {BrakeDataStore} from "../../../out/backend/brake-data-store.js";
import {parseBrakeMessage,canonicalize,sha256Hex} from "../../../out/backend/brake-data-contract.js";
import {applyMigrations,loadMigrations} from "../../../out/backend/migrations.js";
const migrations=loadMigrations(new URL("../../../migrations",import.meta.url).pathname);
const now="2026-09-18T20:00:00.000Z";
function fixture(kind="chunk"){
 const value=JSON.parse(readFileSync(new URL("./fixtures/brake-telemetry-window-"+kind+".v2.valid.json",import.meta.url)));
 delete value.$comment;return value;
}
const parse=m=>parseBrakeMessage(JSON.stringify(m));
test("window detail is bounded at 150 real points and ordered by chunk, not arrival",()=>stored((store)=>{
 const original=fixture(),parts=[];
 for(let part=0;part<15;part++){
 const m=structuredClone(original);
 m.content.chunkIndex=part;m.content.firstSampleIndex=part*10;m.content.sampleCount=10;
 m.content.samples=Array.from({length:10},(_,i)=>({...original.content.samples[0],sampleIndex:part*10+i,
 sourceTimestamp:new Date(Date.parse(original.content.samples[0].sourceTimestamp)+(part*10+i)*200).toISOString(),
 phase:part<5?"PRE":part<10?"ACTIVE":"POST"}));
 m.contentSha256=sha256Hex(canonicalize(m.content));parts.push(m);
 }
 for(const m of parts.toReversed())store.ingest(parse(m),now);
 const detail=store.windowDetail(original.unitSystemUid,original.eventId);
 assert.equal(detail.samples.length,150);
 assert.equal(canonicalize(detail.samples),canonicalize(parts.flatMap(m=>m.content.samples)));
}));
const stored=(fn)=>{const db=new DatabaseSync(":memory:");try{applyMigrations(db,migrations,now);return fn(new BrakeDataStore(db),db);}finally{db.close();}};
test("window detail keeps collection provenance and exact samples; completion-first and hidden later chunk",()=>stored((store)=>{
 const chunk=fixture(),completion=fixture("completion"),uid=chunk.unitSystemUid,id=chunk.eventId;
 assert.equal(store.windowDetail(uid,id),null);
 store.ingest(parse(completion),now);
 assert.deepEqual(store.windowDetail(uid,id).samples,[]);
 assert.equal(store.windowDetail(uid,id).window.projectionState,"PARTIAL");
 store.ingest(parse(chunk),now);
 assert.equal(canonicalize(store.windowDetail(uid,id).samples),canonicalize(chunk.content.samples));
 assert.deepEqual(store.windowDetail(uid,id).window,store.query("WINDOW",uid,10,null).items[0]);
 assert.equal(store.windowDetail("foreign",id),null);
 const later=structuredClone(chunk);later.eventId="00000000-0000-4000-8000-000000000001";
 later.content.chunkIndex=1;later.content.firstSampleIndex=30;
 later.content.samples.forEach((s,i)=>s.sampleIndex=30+i);
 later.contentSha256=sha256Hex(canonicalize(later.content));
 store.ingest(parse(later),now);
 assert.equal(store.windowDetail(uid,later.eventId),null);
}));
test("window detail preserves gaps and phases, leaves conflicts visible, rejects corrupted storage",()=>stored((store,db)=>{
 const chunk=fixture();chunk.content.samples[1].sourceTimestamp="2026-08-22T12:00:02.000Z";
 chunk.contentSha256=sha256Hex(canonicalize(chunk.content));store.ingest(parse(chunk),now);
 assert.equal(canonicalize(store.windowDetail(chunk.unitSystemUid,chunk.eventId).samples),canonicalize(chunk.content.samples));
 const conflict=structuredClone(chunk);conflict.content.samples[0].speedKph=30;conflict.contentSha256=sha256Hex(canonicalize(conflict.content));
 assert.equal(store.ingest(parse(conflict),now).httpStatus,409);
 assert.equal(store.windowDetail(chunk.unitSystemUid,chunk.eventId).window.deliveryState,"CONFLICT");
 db.exec("UPDATE window_chunks SET content_json='{}'");
 assert.throws(()=>store.windowDetail(chunk.unitSystemUid,chunk.eventId),/inconsistent/);
}));
test("legacy and native detail use their original provenance without rewriting messages",()=>stored((store,db)=>{
 for(const legacy of [true,false]){
 const m=fixture();if(legacy){delete m.serviceInstance;m.schemaVersion=1;m.contractVersion="1.0.0";m.serviceVersion="1.0.0";m.serviceArtifactSha256="1".repeat(64);m.eventId="00000000-0000-4000-8000-000000000002";}
 store.ingest(parse(m),now);const before=db.prepare("SELECT canonical_message FROM messages ORDER BY id").all();
 const detail=store.windowDetail(m.unitSystemUid,m.eventId);
 assert.equal(canonicalize(detail.samples),canonicalize(m.content.samples));
 assert.equal("serviceArtifactSha256" in detail.window,legacy);
 assert.deepEqual(db.prepare("SELECT canonical_message FROM messages ORDER BY id").all(),before);
 }
}));
test("window point HTTP read authorizes Unit, rejects query/identity, and returns no paging fields",async()=>{
 const chunk=fixture(),context={schemaVersion:1,contractVersion:"1.0.0",source:"CURRENT_RUN_PROVISIONING_JOURNAL",
 testUnit:{systemUid:chunk.unitSystemUid,unitRole:"VALIDATION",userFacingRole:"Test Vehicle"}};
 const app=await startBackend({currentUnitContext:context});
 const call=(path,body)=>new Promise((resolve,reject)=>{
 const req=request("http://127.0.0.1:"+app.port+"/api/v1/brake"+path,{method:body?"POST":"GET",headers:{"content-type":"application/json"}},r=>{
 let bytes="";r.on("data",p=>bytes+=p);r.on("end",()=>{try{resolve({status:r.statusCode,body:JSON.parse(bytes)});}catch(e){reject(e);}});});
 req.on("error",reject);req.end(body?JSON.stringify(body):undefined);});
 try{
 const route="/units/"+chunk.unitSystemUid+"/windows/"+chunk.eventId;
 assert.equal((await call(route)).status,404);
 assert.equal((await call("/messages",chunk)).status,201);
 const detail=await call(route);assert.equal(detail.status,200);assert.deepEqual(detail.body.samples,chunk.content.samples);
 assert.deepEqual(Object.keys(detail.body).sort(),["schemaVersion","contractVersion","resourceType","unitSystemUid","unitRole","window","samples"].sort());
 for(const suffix of ["?limit=10","?cursor="])assert.equal((await call(route+suffix)).status,400);
 assert.equal((await call("/units/"+chunk.unitSystemUid+"/windows/bad")).status,400);
 assert.equal((await call("/units/foreign/windows/"+chunk.eventId)).body.errorCode,"UNIT_NOT_CURRENT");
 }finally{await app.shutdown();}
});
test("v4-to-v5 migration retains messages and rolls back the complete additive step on failure",()=> {
 const db=new DatabaseSync(":memory:");try{
 applyMigrations(db,migrations.slice(0,4),now);
 const store=new BrakeDataStore(db),m=fixture(),ack=store.ingest(parse(m),now);
 const before=db.prepare("SELECT * FROM messages").all(),receipts=db.prepare("SELECT * FROM receipts").all();
 const failing=[...migrations.slice(0,4),{...migrations[4],sql:migrations[4].sql+"\nSELECT * FROM injected_failure;"}];
 assert.throws(()=>applyMigrations(db,failing,now),/migration 005 failed/);
 assert.equal(db.prepare("PRAGMA user_version").get().user_version,4);
 assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='function_observations'").get(),undefined);
 assert.deepEqual(db.prepare("SELECT * FROM messages").all(),before);
 applyMigrations(db,migrations,now);
 assert.deepEqual(db.prepare("SELECT * FROM messages").all(),before);assert.deepEqual(db.prepare("SELECT * FROM receipts").all(),receipts);
 assert.equal(store.ingest(parse(m),now).acknowledgement.receiptId,ack.acknowledgement.receiptId);
 }finally{db.close();}
});
