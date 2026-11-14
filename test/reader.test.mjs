import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('单页观测保留来源分量和位置引用', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].values[0].unit, 'Cel');
  assert.equal(rows[0].locationRef, 'stop1');
  assert.equal(rows[0].values[1].value, 8);
});
