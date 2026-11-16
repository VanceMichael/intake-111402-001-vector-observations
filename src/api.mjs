import {createServer} from 'node:http';

function json(response,status,body) {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(body,null,2));
}

export async function createApi(archive,port = 0,options = {}) {
  const ledger = options.ledger ?? null;
  const server = createServer(async (request,response) => {
    try {
      if (request.method !== 'GET') return json(response,404,{error:'not found'});
      const url = new URL(request.url,'http://127.0.0.1');
      const path = url.pathname;
      if (path === '/health') return json(response,200,{status:'ok'});
      if (path === '/records') return json(response,200,await archive.list());
      if (!ledger) return json(response,404,{error:'not found'});
      if (path === '/observations') return json(response,200,await ledger.list());
      if (path === '/observations/unresolved') return json(response,200,await ledger.unresolved());
      const match = /^\/observations\/([^/]+)$/.exec(path);
      if (match) {
        const entry = await ledger.get(decodeURIComponent(match[1]));
        return entry ? json(response,200,entry) : json(response,404,{error:'unknown observation'});
      }
      return json(response,404,{error:'not found'});
    } catch(error) {json(response,500,{error:error.message});}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}
