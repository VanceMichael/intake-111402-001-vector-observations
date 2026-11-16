import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collect} from './reader.mjs';
import {Archive} from './archive.mjs';
import {ObservationLedger} from './projection.mjs';
import {createApi} from './api.mjs';

const dataDirectory = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(dataDirectory);
const ledger = new ObservationLedger(dataDirectory);
const api = await createApi(archive,Number(process.env.PORT ?? 4020),{ledger});
console.log(JSON.stringify({source:source.origin,api:api.origin}));

async function ingest() {
  const rows = await collect(createClient(source.origin));
  if (!rows.length) return null;
  const archived = await archive.put(rows,{source:source.origin,adapter:'current'});
  const projected = await ledger.apply(rows,{source:source.origin,adapter:'current'});
  return {archived,projected};
}

try {
  const result = await ingest();
  if (result) console.log(JSON.stringify(result));
} catch(error) {console.error(error.message);}

let timer = null;
if (Number(process.env.POLL_MS ?? 0) > 0) {
  timer = setInterval(() => {
    ingest().then(result => {
      if (result && (result.projected.added || result.projected.conflicts)) console.log(JSON.stringify(result));
    }).catch(error => console.error(error.message));
  },Number(process.env.POLL_MS));
  timer.unref();
}

let stopping = false;
const stop = async () => {
  if(stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  await Promise.all([source.close(),api.close()]);
};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
