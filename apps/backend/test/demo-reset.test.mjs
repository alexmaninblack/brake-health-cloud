// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DemoResetStore,resetSchema} from "../../../out/backend/demo-reset.js";
const binding = {schemaVersion:1,unitSystemUid:"current-test",serviceVersion:"49.0.0",
  serviceInstance:{serviceId:"brake-service",subjectId:"brake-subject",instanceIndex:0,instanceId:"native-instance"},
  producerEpoch:"250cd5eb-7c24-4347-8006-a22c79cf9ff7"};

// Reset persistence tests intentionally share the production protocol shape.
test("reset completion requires matching CLEAR; ACK and creation survive restart without repeating", () => {
  const directory = mkdtempSync(join(tmpdir(),"reset-recovery-"));
  const path = join(directory,"state.sqlite");
  let now = Date.parse("2026-09-16T12:00:00.000Z");
  let db = new DatabaseSync(path);
  for(const sql of resetSchema) db.exec(sql);
  let store = new DemoResetStore(db, () => "current-test", () => now);
  const create = {schemaVersion:1,unitSystemUid:"current-test",commandId:randomUUID()};
  try {
    store.poll(binding); store.create(create);
    const request = {schemaVersion:1,requestId:randomUUID(),producerEpoch:binding.producerEpoch,sequence:9,
      operation:"CLEAR",reasonCode:"CONDITION_CLEARED",decisionId:create.commandId,
      serviceVersion:binding.serviceVersion,modelVersion:"demo-model-v1",
      issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString()};
    const status = {schemaVersion:1,requestId:request.requestId,producerEpoch:request.producerEpoch,
      sequence:request.sequence,state:"CLEARED",reason:"NONE",gatewayObservedAt:new Date(now+100).toISOString(),
      activeRecommendation:"NONE",activeReasonCode:"NONE",activeUntil:null};
    const ack = {...binding,commandId:create.commandId,result:"CLEARED",clearRequest:request,gatewayStatus:status};
    now += 500;
    for(const mutate of [
      x => {x.gatewayStatus.requestId=randomUUID();},
      x => {x.gatewayStatus.state="RECEIVED";},
      x => {x.gatewayStatus.reason="INTERNAL_ERROR";},
      x => {x.gatewayStatus.activeRecommendation="TIRE_INSPECTION_RECOMMENDED";},
      x => {x.clearRequest.recommendation="TIRE_INSPECTION_RECOMMENDED";},
      x => {x.clearRequest.issuedAt="2026-09-16T11:59:59.000Z";},
      x => {x.gatewayStatus.gatewayObservedAt="2026-09-16T12:01:00.000Z";},
      x => {x.gatewayStatus.extra=true;},
      x => {x.clearRequest.schemaVersion=2;}
    ]) {const wrong=structuredClone(ack);mutate(wrong);assert.throws(()=>store.acknowledge(wrong),/CLEAR_NOT_CONFIRMED/);}
    assert.equal(store.status("current-test").command.state,"PENDING");
    db.close(); db = new DatabaseSync(path);
    store = new DemoResetStore(db, () => "current-test", () => now);
    assert.equal(store.create(create).command.commandId,create.commandId);
    assert.equal(store.poll(binding).command.commandId,create.commandId);
    now += 61000;
    const before = db.prepare("SELECT state FROM demo_reset_commands").get().state;
    assert.equal(store.status("current-test").command.state,"EXPIRED");
    assert.equal(db.prepare("SELECT state FROM demo_reset_commands").get().state,before,"GET must not mutate");
    assert.equal(store.poll(binding).command,null,"expired command is never delivered for new execution");
    assert.equal(store.acknowledge(ack).state,"CLEARED","late proof reconciles a CLEAR issued before expiry");
    assert.deepEqual(store.acknowledge(ack),{schemaVersion:1,commandId:create.commandId,state:"CLEARED"});
    assert.throws(()=>store.acknowledge({...ack,result:"FAILED",clearRequest:null,gatewayStatus:null}),/ACK_CONFLICT/);
    assert.equal(store.poll(binding).command,null,"completed command is never delivered again");
    assert.equal(store.create(create).command.state,"CLEARED");
    db.close();db = new DatabaseSync(path);
    assert.equal(new DemoResetStore(db, () => "current-test", () => now).status("current-test").command.state,"CLEARED");
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});

test("command history is bounded, fresh binding is required and foreign Unit cannot inspect it", () => {
  const db = new DatabaseSync(":memory:");
  for(const sql of resetSchema) db.exec(sql);
  let now = Date.parse("2026-09-16T12:00:00Z");
  const store = new DemoResetStore(db, () => "current-test", () => now);
  try {
    for(let i=0;i<40;i++){
      store.poll(binding);
      const commandId=randomUUID();
      store.create({schemaVersion:1,unitSystemUid:"current-test",commandId});
      store.acknowledge({...binding,commandId,result:"FAILED",clearRequest:null,gatewayStatus:null});
      now++;
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM demo_reset_commands").get().n,32);
    assert.throws(()=>store.status("production"),/UNIT_NOT_CURRENT/);
    now+=16000;
    assert.throws(()=>store.create({schemaVersion:1,unitSystemUid:"current-test",commandId:randomUUID()}),/NOT_CONNECTED/);
    assert.throws(()=>store.poll({...binding,serviceInstance:{...binding.serviceInstance,extra:true}}),/INVALID_REQUEST/);
  } finally {db.close();}
});
