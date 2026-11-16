import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';

let source;
before(async () => {source = await createSource({scenario:'probe-change'});});
after(async () => {await source.close();});
const client = () => createClient(source.origin);

test('同页混合定义版本按各自版本解释分量与单位', async () => {
  const rows = await collect(client());
  assert.deepEqual(rows.map(row => row.id),['o2','o3']);
  const old = rows.find(row => row.id === 'o2');
  const current = rows.find(row => row.id === 'o3');
  assert.equal(old.definitionVersion,'d1');
  assert.deepEqual(old.values.map(value => [value.id,value.unit,value.value]),
    [['temperature','Cel',null],['pm','ug/m3',7]]);
  assert.equal(old.values[0].state,'null');
  assert.equal(old.values[0].missing,false);
  assert.equal(current.definitionVersion,'d2');
  assert.deepEqual(current.values.map(value => [value.id,value.unit,value.value]),
    [['pm','ug/m3',6],['temperature','Cel',null]]);
  assert.equal(current.values[1].state,'missing');
  assert.equal(current.values[1].missing,true);
  assert.deepEqual(current.missingValues,['temperature']);
});

test('观测定值不随当前流定义改写', async () => {
  const rows = await collect(client());
  const stream = await client()('/streams/air');
  assert.equal(stream.definition,'d2');
  const old = rows.find(row => row.id === 'o2');
  assert.deepEqual(old.definitionInfo.components.map(component => component.id),['temperature','pm']);
  assert.equal(old.values[0].value,null);
  assert.equal(old.values[1].value,7);
});

test('空值与未提供值分别保留', async () => {
  const rows = await collect(client());
  const old = rows.find(row => row.id === 'o2');
  const current = rows.find(row => row.id === 'o3');
  assert.equal(old.resultProvided,true);
  assert.equal(old.values[0].provided,true);
  assert.equal(old.values[0].state,'null');
  assert.equal(current.values[1].provided,false);
  assert.equal(current.values[1].state,'missing');
  assert.equal(current.partial,true);
  assert.equal(current.complete,false);
});

test('位置引用与历史位置一起收存', async () => {
  const rows = await collect(client());
  const stop1 = rows.find(row => row.id === 'o3');
  const stop2 = rows.find(row => row.id === 'o2');
  assert.equal(stop1.locationRef,'stop1');
  assert.deepEqual(stop1.location.point,[112.9,28.2]);
  assert.equal(stop2.locationRef,'stop2');
  assert.deepEqual(stop2.location.point,[113,28.2]);
  assert.equal(stop2.status,'resolved');
});

test('来源未给出探头时不猜测探头', async () => {
  const rows = await collect(client());
  for (const row of rows) {
    assert.equal(row.probe,null);
    assert.deepEqual(row.probes,[]);
    assert.equal(row.associations.probe.resolved,false);
  }
});
