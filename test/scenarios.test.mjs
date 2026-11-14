import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('probe-change');
const stream = await client('/streams/air');
const old = await client('/definitions/d1');
assert.notEqual(stream.components[0].id,old.components[0].id);
const rows = (await client('/observations?stream=air&page=1')).items;
assert.equal(rows[0].result[0],null);
assert.equal(rows[1].result.length,1);
} finally {await source.close();}
});
