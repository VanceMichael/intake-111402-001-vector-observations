import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';

test('定义换版前后同页观测各自收存', async () => {
  const source = await createSource({scenario:'probe-change'});
  try {
    const rows = await collect(createClient(source.origin));
    assert.deepEqual(rows.map(row => [row.id,row.definitionVersion]),[['o2','d1'],['o3','d2']]);
    assert.deepEqual(rows[0].values.map(value => value.id),['temperature','pm']);
    assert.deepEqual(rows[1].values.map(value => value.id),['pm','temperature']);
  } finally {await source.close();}
});

test('缺失位置暂不解释观测，补发后才可解释', async () => {
  const source = await createSource({scenario:'location-pending'});
  try {
    const client = createClient(source.origin);
    const rows = await collect(client);
    const pending = rows.find(row => row.id === 'o2');
    assert.equal(pending.status,'unresolved');
    assert.equal(pending.interpretable,false);
    assert.deepEqual(pending.unresolved,['location']);
    assert.deepEqual(pending.unresolvedDetails, [{kind:'location',ref:'stop2',status:404,
      reason:'not-published',message:'location not published'}]);
    assert.equal(pending.location,null);
    assert.equal(rows.find(row => row.id === 'o3').status,'resolved');
    const retry = await collect(client);
    const filled = retry.find(row => row.id === 'o2');
    assert.equal(filled.status,'resolved');
    assert.deepEqual(filled.location.point,[113,28.2]);
    assert.equal(filled.locationRef,'stop2');
    assert.equal(retry.find(row => row.id === 'o3').status,'resolved');
  } finally {await source.close();}
});

test('不可解释的观测不被猜测值替换', async () => {
  const source = await createSource({scenario:'location-pending'});
  try {
    const rows = await collect(createClient(source.origin));
    const pending = rows.find(row => row.id === 'o2');
    assert.equal(pending.locationPoint,null);
    assert.equal(pending.locationValidAt,null);
    assert.equal(pending.associations.location.resolved,false);
    assert.equal(pending.associations.definition.resolved,true);
  } finally {await source.close();}
});
