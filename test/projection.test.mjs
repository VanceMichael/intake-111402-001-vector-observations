import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ObservationLedger} from '../src/projection.mjs';

function row(id,overrides = {}) {
  return {
    id,
    observationId:id,
    stream:'air',
    definitionVersion:'d1',
    definitionInfo:{components:[{id:'temperature',unit:'Cel'},{id:'pm',unit:'ug/m3'}]},
    locationRef:'stop1',
    location:{point:[112.9,28.2],validAt:10},
    probe:null,
    probeByComponent:{},
    quality:null,
    values:[{id:'temperature',unit:'Cel',value:21,missing:false},
      {id:'pm',unit:'ug/m3',value:8,missing:false}],
    missingValues:[],
    extraValues:[],
    issues:[],
    ...overrides,
  };
}

async function ledgerAt() {
  const directory = await mkdtemp(join(tmpdir(),'ledger-'));
  return {directory,ledger:new ObservationLedger(directory)};
}

test('观测作为整体收存，重复领取不产生新含义', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    const first = await ledger.apply([row('o1')],{source:'local'});
    assert.deepEqual(first,{confirmed:1,partial:0,unresolved:0,conflicts:0,added:1,unchanged:0,total:1});
    const second = await ledger.apply([row('o1')],{source:'local'});
    assert.equal(second.unchanged,1);
    const [entry] = await ledger.list();
    assert.equal(entry.status,'confirmed');
    assert.deepEqual(entry.definition.components.map(component => component.id),['temperature','pm']);
    assert.deepEqual(entry.location.point,[112.9,28.2]);
    assert.equal(entry.seenCount,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('关联资料后到可补齐且不改写已确认值', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    const pending = row('o1',{location:null});
    assert.equal((await ledger.apply([pending],{source:'local'})).unresolved,1);
    assert.deepEqual(await ledger.unresolved(),[await ledger.get('o1')]);
    const summary = await ledger.apply([row('o1')],{source:'local'});
    assert.equal(summary.confirmed,1);
    const entry = await ledger.get('o1');
    assert.deepEqual(entry.location.point,[112.9,28.2]);
    assert.deepEqual(entry.associations,['definition','location']);
    assert.equal(entry.locationRef,'stop1');
    assert.equal(entry.values[0].value,21);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('补发换用其他位置或定义时保留原含义并记录冲突', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    await ledger.apply([row('o1',{location:null})],{source:'local'});
    const moved = row('o1',{locationRef:'stop9',location:{point:[0,0],validAt:99}});
    const summary = await ledger.apply([moved],{source:'local'});
    assert.equal(summary.conflicts,1);
    const entry = await ledger.get('o1');
    assert.equal(entry.status,'unresolved');
    assert.equal(entry.location,null);
    assert.equal(entry.locationRef,'stop1');
    assert.equal(entry.conflictCount,1);
    assert.equal(entry.conflicts[0].field,'location');
    assert.equal(entry.conflicts[0].reason,'identity-mismatch');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('来源空值与未提供值在收存后保持区别', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    const partial = row('o1',{values:[
      {id:'temperature',unit:'Cel',value:null,missing:false,state:'null'},
      {id:'pm',unit:'ug/m3',value:null,missing:true,state:'missing'},
    ],missingValues:['pm']});
    await ledger.apply([partial],{source:'local'});
    const entry = await ledger.get('o1');
    assert.equal(entry.values[0].state,'null');
    assert.equal(entry.values[1].state,'missing');
    assert.deepEqual(entry.missingValues,['pm']);
    assert.equal(entry.status,'partial');
    assert.equal(entry.completeValues,false);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('已确认值不被后续不同读数覆盖', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    await ledger.apply([row('o1')],{source:'local'});
    const changed = row('o1',{values:[
      {id:'temperature',unit:'Cel',value:30,missing:false},
      {id:'pm',unit:'ug/m3',value:8,missing:false},
    ]});
    const summary = await ledger.apply([changed],{source:'local'});
    assert.equal(summary.conflicts,1);
    const entry = await ledger.get('o1');
    assert.equal(entry.values[0].value,21);
    assert.equal(entry.status,'confirmed');
    assert.equal(entry.conflicts[0].component,'temperature');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('只补空位，不把缺失值伪造成观测值', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    const partial = row('o1',{values:[
      {id:'temperature',unit:'Cel',value:21,missing:false},
      {id:'pm',unit:'ug/m3',value:null,missing:true},
    ],missingValues:['pm']});
    await ledger.apply([partial],{source:'local'});
    const filled = row('o1',{values:[
      {id:'temperature',unit:'Cel',value:21,missing:false},
      {id:'pm',unit:'ug/m3',value:9,missing:false},
    ],missingValues:[]});
    assert.equal((await ledger.apply([filled],{source:'local'})).conflicts,0);
    const entry = await ledger.get('o1');
    assert.equal(entry.values[1].value,9);
    assert.deepEqual(entry.missingValues,[]);
    assert.equal(entry.status,'confirmed');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('定义换版不追溯改写已收观测', async () => {
  const {directory,ledger} = await ledgerAt();
  try {
    await ledger.apply([row('o1')],{source:'local'});
    const reordered = row('o1',{
      definitionVersion:'d2',
      definitionInfo:{components:[{id:'pm',unit:'ug/m3'},{id:'temperature',unit:'Cel'}]},
      values:[{id:'pm',unit:'ug/m3',value:8,missing:false},
        {id:'temperature',unit:'Cel',value:21,missing:false}],
    });
    const summary = await ledger.apply([reordered],{source:'local'});
    assert.equal(summary.conflicts,1);
    const entry = await ledger.get('o1');
    assert.equal(entry.definitionRef,'d1');
    assert.deepEqual(entry.definition.components.map(component => component.id),['temperature','pm']);
    assert.deepEqual(entry.values.map(value => value.id),['temperature','pm']);
  } finally {await rm(directory,{recursive:true,force:true});}
});
