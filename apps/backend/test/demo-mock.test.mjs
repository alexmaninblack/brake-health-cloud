// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {request} from "node:http";
import {startBackend} from "../../../out/backend/server.js";
import {adminOperation} from "../../../out/backend/main.js";

test("DEMO_MOCK real HTTP, native payloads, durable duplicate, isolated queries and private cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-mock-http-"));
  const context = {schemaVersion:1, contractVersion:"1.0.0", source:"CURRENT_RUN_PROVISIONING_JOURNAL",
    testUnit:{systemUid:"mock-test-unit",unitRole:"VALIDATION",userFacingRole:"Test Vehicle"}};
  const contextPath = join(directory,"context.json"); writeFileSync(contextPath,JSON.stringify(context));
  const options = {databasePath:join(directory,"data.sqlite"),adminSocketPath:join(directory,"admin.sock"),currentUnitContext: context, migrationsDirectory: resolve("migrations")};
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/brake-health-assessment.v2.valid.json",import.meta.url)));
  delete fixture.$comment; fixture.unitSystemUid="mock-test-unit"; fixture.unitRole="VALIDATION";
  const messages = process.env.DEMO_MOCK_PRODUCER_TEST
    ? execFileSync(process.env.DEMO_MOCK_PRODUCER_TEST,["--emit"],{encoding:"utf8",timeout:30000,maxBuffer:2097152}).trim().split("\n").map(JSON.parse)
    : [fixture];
  let app;
  const call = (path,body,marker=true) => new Promise((done,reject) => {
    const bytes=body===undefined?undefined:JSON.stringify(body);
    const call=request({hostname:"127.0.0.1",port:app.port,path:"/api/v1/brake/"+path,
      method:body===undefined?"GET":"POST",headers:bytes===undefined?{}:{"content-type":"application/json","content-length":Buffer.byteLength(bytes),...(marker?{"x-aos-demo-source":"MOCK"}:{})}},res=>{
      let text="";res.on("data",part=>text+=part);res.on("end",()=>done({status:res.statusCode,body:JSON.parse(text)}));
    });call.on("error",reject);call.end(bytes);
  });
  const admin = (path, body) => new Promise((done,reject) => {
    const bytes=JSON.stringify(body);
    const call=request({socketPath:options.adminSocketPath,path:"/api/v1/brake/demo-mock/admin/"+path,method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(bytes)}},res=>{
      let text="";res.on("data",part=>text+=part);res.on("end",()=>done({status:res.statusCode,body:JSON.parse(text)}));
    });call.on("error",reject);call.end(bytes);
  });
  try {
    app = await startBackend(options);
    assert.notEqual((await call("demo-mock/messages",messages[0],false)).status,201);
    assert.notEqual((await call("messages",messages[0])).status,201);
    assert.notEqual((await call("demo-mock/messages",{...messages[0],unitSystemUid:"production",unitRole:"PRODUCTION"})).status,201);
    let first;
    for (const message of messages) {
      const result=await call("demo-mock/messages",message);assert.equal(result.status,201,JSON.stringify(result.body));first??=result;
    }
    const summary=await call("demo-mock/summary");
    assert.equal(summary.status,200);assert.equal(summary.body.source,"DEMO_MOCK");assert.equal(summary.body.vehicleTelemetry,false);
    assert.equal(summary.body.counts.reduce((sum,row)=>sum+row.count,0),messages.length);
    assert.equal((await call("units/mock-test-unit/assessments")).body.items.length,0);
    await app.shutdown();app=await startBackend(options);
    const duplicate=await call("demo-mock/messages",messages[0]);
    assert.equal(duplicate.status,200);assert.equal(duplicate.body.receiptId,first.body.receiptId);
    const envelope={schemaVersion:1,contractVersion:"1.0.0"};
    const preview=await adminOperation("mock-preview",JSON.stringify({...envelope,systemUids:["mock-test-unit"]}),options.adminSocketPath);
    assert.equal(preview.status,200);
    const cleaned=await adminOperation("mock-execute",JSON.stringify({...envelope,systemUids:["mock-test-unit"],confirmationToken:preview.body.confirmationToken}),options.adminSocketPath);
    assert.equal(cleaned.status,200);
    assert.equal((await call("demo-mock/summary")).body.counts.length,0);
    assert.equal((await adminOperation("mock-empty-proof",JSON.stringify(envelope),options.adminSocketPath)).body.state,"EMPTY");
  } finally {await app?.shutdown();rmSync(directory,{recursive:true,force:true});}
});
