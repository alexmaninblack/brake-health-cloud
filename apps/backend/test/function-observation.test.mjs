// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {request} from "node:http";
import {startBackend} from "../../../out/backend/server.js";
import {adminOperation} from "../../../out/backend/main.js";
import {observationCanonical,observationDigest} from "../../../out/backend/function-observation.js";
const migrationsDirectory=new URL("../../../migrations",import.meta.url).pathname;
function fixture(team, sequence=1, generation=1) {
 const m={schemaVersion:3,contractVersion:"3.0.0",messageType:team.toUpperCase()+"_FUNCTION_OBSERVATION",unitSystemUid:"test-unit",unitRole:"VALIDATION",
 serviceInstance:{serviceId:team,subjectId:"subject",instanceIndex:0,instanceId:"instance"},serviceVersion:"60.0.0",serviceProfile:team==="brake"?"v3":"v1",
 generation,sequence,observedAt:"2026-09-18T20:00:00.000Z",content:{connection:"CONNECTED",input:{state:"RECEIVING",reason:"NONE"},
 activity:{state:"WAITING",reason:"NOT_QUALIFIED",episodeId:null},delivery:{state:"IDLE",queuedMessages:0,lastReceiptAt:null},
 advisory:{state:"WAITING",requestId:null},lastResult:null}};
 return {...m,contentSha256:observationDigest(observationCanonical(m.content))};
}

const team="brake";
const context={schemaVersion:1,contractVersion:"1.0.0",source:"CURRENT_RUN_PROVISIONING_JOURNAL",
 testUnit:{systemUid:"test-unit",unitRole:"VALIDATION",userFacingRole:"Test Vehicle"},
 productionUnit:{systemUid:"peer-unit",unitRole:"PRODUCTION",userFacingRole:"Production Vehicle"}};
test("v3 HTTP observation migration: scoped ingestion, late delivery, conflict, restart and peer-preserving cleanup",async()=>{
 const directory=mkdtempSync(join(tmpdir(),team+"-observations-"));
 const contextPath=join(directory,"context.json");writeFileSync(contextPath,JSON.stringify(context));
 const options={databasePath:join(directory,"data.sqlite"),adminSocketPath:join(directory,"admin.sock"),contextPath,
 migrationsDirectory,currentUnitContext:context};
 let app;
 const call=(path,body,headers={})=>new Promise((resolve,reject)=>{
   const req=request("http://127.0.0.1:"+app.port+"/api/v1/"+team+path,
     {method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",...headers}},response=>{
       let bytes="";response.setEncoding("utf8");response.on("data",part=>{bytes+=part;});
       response.on("end",()=>{try{resolve({status:response.statusCode,body:JSON.parse(bytes)});}catch(error){reject(error);}});
     });
   req.on("error",reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 const admin=async(op,body)=>adminOperation(op,JSON.stringify(body),app.adminSocketPath ?? options.adminSocketPath);
 try{
   app=await startBackend(options);
   const fresh=fixture(team,3,2), old=fixture(team,999,1);
   const receipt=await call("/messages",fresh);assert.equal(receipt.status,201);
   const duplicate=await call("/messages",fresh);assert.equal(duplicate.status,200);assert.equal(duplicate.body.receiptId,receipt.body.receiptId);
   assert.equal((await call("/messages",old)).status,201);
   const state=await call("/units/test-unit/function-observations?limit=10");
   assert.equal(state.status,200);assert.equal(state.body.items[0].message.sequence,3);
   assert.equal((await call("/units/foreign/function-observations")).status,404);
   assert.equal((await call("/units/test-unit/function-observations?limit=0")).status,400);
   assert.equal((await call("/units/test-unit/function-observations?cursor=bad")).status,400);
   const bad={...fixture(team,4,2),extra:"forbidden"};assert.equal((await call("/messages",bad)).status,422);
   assert.equal((await call("/messages",{...fresh,unitSystemUid:"foreign"})).status,404);
   assert.equal((await call("/messages",fresh,{Origin:"http://browser.test"})).status,400);
   fresh.observedAt="2026-09-18T20:00:01.000Z";assert.equal((await call("/messages",fresh)).status,409);
   assert.equal((await call("/units/test-unit/function-observations")).body.items[0].deliveryState,"CONFLICT");
   const peer=fixture(team);peer.unitSystemUid="peer-unit";peer.unitRole="PRODUCTION";
   assert.equal((await call("/messages",peer)).status,201);
   await app.shutdown();app=await startBackend(options);
   assert.equal((await call("/units/test-unit/function-observations")).body.items[0].message.sequence,3);
   const selector={schemaVersion:1,contractVersion:"1.0.0",systemUids:["test-unit"]};
   const preview=await admin("preview",selector);assert.equal(preview.status,200);
   assert.equal(preview.body.recordCounts.functionObservations,2);assert.equal(preview.body.recordCounts.functionObservationConflicts,1);
   const clean=await admin("execute",{...selector,confirmationToken:preview.body.confirmationToken});assert.equal(clean.status,200);
   assert.equal((await call("/units/test-unit/function-observations")).body.items.length,0);
   assert.equal((await call("/units/peer-unit/function-observations")).body.items.length,1);
   assert.deepEqual(clean.body.nonmatchingRecordCounts,preview.body.nonmatchingRecordCounts);
 }finally{if(app)await app.shutdown();rmSync(directory,{recursive:true,force:true});}
});
