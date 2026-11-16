import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {ObservationLedger} from '../src/projection.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const ledger = new ObservationLedger(directory);
const api = await createApi(archive,0,{ledger});
const ingest = async () => {
  const rows = await collect(createClient(source.origin));
  return {archived:await archive.put(rows,{source:source.origin,adapter:'current'}),
    projected:await ledger.apply(rows,{source:source.origin,adapter:'current'})};
};
try {
  console.log('本地来源',source.origin);
  const first = await ingest();
  console.log('实际收件',JSON.stringify(first));
  const pending = await ledger.unresolved();
  if (pending.length) {
    console.log('尚不能解释',JSON.stringify(pending.map(entry => ({id:entry.id,
      unresolved:entry.status === 'unresolved' ? undefined : entry.missingValues,
      refs:{definition:entry.definitionRef,location:entry.locationRef}}))));
    console.log('重新领取补齐',JSON.stringify(await ingest()));
  }
  console.log('查询原始结果',await (await fetch(`${api.origin}/records`)).text());
  console.log('查询业务投影',await (await fetch(`${api.origin}/observations`)).text());
  console.log('来源交互',JSON.stringify(await createClient(source.origin)('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
