function candidates(entry,fixture,scenario) {
  const routes = [...(fixture.cases[scenario] ?? []),...fixture.exchanges];
  return routes.filter(route => route.method === entry.method && route.path === entry.path &&
    Object.entries(route.query ?? {}).every(([key,value]) => entry.query[key] === value));
}

function precondition(state,route) {
  return Object.entries(route.requires ?? {}).every(([key,value]) => state[key] === value);
}

// 同一会话内重复读取同一来源资源时，按资料顺序视为先 404 后补发。
// 仅当首次读取明确为 404 时接管；其余资源仍由 source.mjs 的静态匹配处理。
export function behavior(entry,state,fixture,scenario) {
  if (entry.method !== 'GET') return null;
  const matches = candidates(entry,fixture,scenario);
  if (matches.length < 2 || matches[0].status !== 404) return null;
  const key = `reads:${entry.method} ${entry.path} ${JSON.stringify(entry.query)}`;
  const count = state[key] ?? 0;
  const chosen = count === 0 ? matches[0] : matches[matches.length - 1];
  if (!precondition(state,chosen)) return {status:409,body:{error:'source state precondition'}};
  state[key] = count + 1;
  Object.assign(state,chosen.sets ?? {});
  return {status:chosen.status ?? 200,body:chosen.body};
}
