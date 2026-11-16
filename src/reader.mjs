const DEFAULT_STREAM = 'air';
const DEFAULT_MAX_PAGES = 100;
const PROBE_FIELDS = ['probe','probeRef','probeId','sensor','sensorRef','sensorId',
  'device','deviceRef','deviceId','instrument','instrumentRef','instrumentId'];
const QUALITY_FIELDS = ['quality','qualityFlag','qualityFlags','qualityStatus','qc','qcFlag',
  'flag','flags'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodeId(value) {
  return encodeURIComponent(String(value));
}

function hasValue(object,key) {
  return isObject(object) && Object.hasOwn(object,key) && object[key] !== undefined;
}

function firstField(object,fields) {
  if (!isObject(object)) return null;
  for (const field of fields) {
    if (hasValue(object,field)) return {field,value:object[field]};
  }
  return null;
}

function definitionReference(item) {
  const definition = item?.definition;
  if (typeof definition === 'string' && definition) return definition;
  if (typeof definition === 'number') return String(definition);
  if (isObject(definition)) {
    for (const field of ['ref','id','version']) {
      if (typeof definition[field] === 'string' && definition[field]) return definition[field];
    }
  }
  return null;
}

function locationReference(item) {
  const reference = item?.locationRef ?? item?.locationReference;
  if (typeof reference === 'string' && reference) return reference;
  if (typeof reference === 'number') return String(reference);
  if (isObject(reference)) {
    for (const field of ['ref','id']) {
      if (typeof reference[field] === 'string' && reference[field]) return reference[field];
    }
  }
  if (typeof item?.location === 'string' && item.location) return item.location;
  if (isObject(item?.location)) {
    for (const field of ['ref','id']) {
      if (typeof item.location[field] === 'string' && item.location[field]) return item.location[field];
    }
  }
  return null;
}

function definitionComponents(body) {
  if (!isObject(body)) return null;
  for (const candidate of [body.components,body.definition?.components,body.stream?.components]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function normalizedComponents(body) {
  const components = definitionComponents(body);
  if (!components || components.length === 0 || components.some(component => !isObject(component) ||
    component.id === undefined || component.id === null || String(component.id) === '')) return null;
  return components.map(component => ({...component,id:String(component.id)}));
}

function inlineDefinition(item) {
  for (const candidate of [item?.definition,item?.definitionInfo,item?.definitionSnapshot]) {
    if (isObject(candidate) && normalizedComponents(candidate)) return candidate;
  }
  return null;
}

function inlineLocation(item) {
  for (const candidate of [item?.location,item?.locationInfo]) {
    if (isObject(candidate) && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function failure(error,notFoundReason) {
  if (typeof error?.status === 'number') {
    return {
      ok:false,
      status:error.status,
      reason:error.status === 404 ? notFoundReason : 'unavailable',
      message:typeof error.data?.error === 'string' ? error.data.error : error.message,
    };
  }
  return {ok:false,status:null,reason:'unavailable',message:error?.message ?? null};
}

function pagePath(stream,next) {
  if (typeof next === 'string' && /^(?:https?:)?\/\//.test(next)) return next;
  if (typeof next === 'string' && next.startsWith('/')) return next;
  return `/observations?stream=${encodeURIComponent(stream)}&page=${encodeURIComponent(String(next))}`;
}

function nextPage(next) {
  if (next === null || next === undefined || next === false || next === '') return null;
  if (typeof next === 'number') return String(next);
  if (typeof next === 'string') return next;
  if (isObject(next)) {
    if (next.page !== undefined && next.page !== null) return String(next.page);
    if (typeof next.url === 'string' && next.url) return next.url;
    if (typeof next.ref === 'string' && next.ref) return next.ref;
  }
  return null;
}

async function readObservations(client,stream,options) {
  const items = [];
  const visited = new Set();
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages : DEFAULT_MAX_PAGES;
  let next = options.startPage ?? options.page ?? '1';
  for (let count = 0; next !== null && count < maxPages; count++) {
    const path = pagePath(stream,next);
    if (visited.has(path)) break;
    visited.add(path);
    const page = await client(path);
    if (!isObject(page) || !Array.isArray(page.items)) throw new Error('invalid observation page');
    items.push(...page.items);
    next = nextPage(page.next);
  }
  return items;
}

function qualityAt(quality,index,id) {
  if (Array.isArray(quality)) return quality[index];
  if (isObject(quality)) return quality[id];
  return undefined;
}

function addOptional(entry,key,value) {
  if (value !== undefined) entry[key] = value;
}

function mapResult(components,result,resultProvided,observationQuality) {
  const isArray = Array.isArray(result);
  const isObjectResult = isObject(result);
  const wholeNull = resultProvided && result === null;
  const values = [];
  const extraValues = [];
  const issues = [];
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    let present = false;
    let raw;
    if (wholeNull) {
      present = true;
      raw = null;
    } else if (isArray && index < result.length) {
      present = true;
      raw = result[index];
    } else if (isObjectResult && Object.hasOwn(result,component.id)) {
      present = true;
      raw = result[component.id];
    }
    const entry = {...component,index,present,provided:present,missing:!present};
    if (!present) {
      entry.value = null;
      entry.state = 'missing';
      values.push(entry);
      continue;
    }
    let value = raw;
    let embeddedQuality;
    let embeddedFlag;
    if (isObject(raw) && Object.hasOwn(raw,'value')) {
      value = raw.value;
      embeddedQuality = firstField(raw,QUALITY_FIELDS)?.value;
      embeddedFlag = embeddedQuality;
    }
    const quality = embeddedQuality !== undefined
      ? embeddedQuality : qualityAt(observationQuality,index,component.id);
    entry.value = value;
    entry.state = value === null ? 'null' : 'value';
    addOptional(entry,'quality',quality);
    addOptional(entry,'qualityFlag',embeddedFlag ?? quality);
    values.push(entry);
  }
  if (isArray) {
    for (let index = components.length; index < result.length; index++) {
      extraValues.push({index,value:result[index],provided:true});
    }
  } else if (isObjectResult) {
    const known = new Set(components.map(component => component.id));
    for (const [id,value] of Object.entries(result)) {
      if (!known.has(id) && !QUALITY_FIELDS.includes(id)) extraValues.push({id,value,provided:true});
    }
  }
  if (!resultProvided) issues.push({kind:'result',reason:'missing-result'});
  else if (!wholeNull && !isArray && !isObjectResult) issues.push({kind:'result',reason:'invalid-result'});
  if (extraValues.length) issues.push({kind:'result',reason:'unexpected-values',count:extraValues.length});
  const completeResult = resultProvided && !issues.some(issue =>
    issue.reason === 'missing-result' || issue.reason === 'invalid-result') &&
    values.every(entry => entry.present) && extraValues.length === 0;
  return {values,extraValues,issues,completeResult};
}

async function resolveDefinition(client,reference,cache) {
  if (cache.has(reference)) return cache.get(reference);
  let outcome;
  try {
    const body = await client(`/definitions/${encodeId(reference)}`);
    outcome = normalizedComponents(body)
      ? {ok:true,value:body}
      : {ok:false,status:null,reason:'invalid-definition',message:null};
  } catch (error) {
    outcome = failure(error,'not-found');
  }
  cache.set(reference,outcome);
  return outcome;
}

async function resolveLocation(client,reference,cache) {
  if (cache.has(reference)) return cache.get(reference);
  let outcome;
  try {
    const body = await client(`/locations/${encodeId(reference)}`);
    outcome = isObject(body)
      ? {ok:true,value:body}
      : {ok:false,status:null,reason:'invalid-location',message:null};
  } catch (error) {
    outcome = failure(error,'not-published');
  }
  cache.set(reference,outcome);
  return outcome;
}

function probeId(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isObject(value)) {
    for (const field of ['id','ref','probeId','sensorId','deviceId']) {
      if (value[field] !== undefined && value[field] !== null && String(value[field]) !== '') {
        return String(value[field]);
      }
    }
  }
  return null;
}

function uniqueValues(values) {
  const unique = [];
  for (const value of values) {
    if (!unique.some(seen => JSON.stringify(seen) === JSON.stringify(value))) unique.push(value);
  }
  return unique;
}

function probeSummary(item,definition,components) {
  const observed = firstField(item,PROBE_FIELDS);
  const defined = firstField(definition,PROBE_FIELDS);
  const byComponent = {};
  const encountered = [];
  for (const component of components) {
    const probe = firstField(component,PROBE_FIELDS);
    if (!probe) continue;
    byComponent[component.id] = probe.value;
    encountered.push(probe.value);
  }
  if (observed) encountered.push(observed.value);
  if (defined) encountered.push(defined.value);
  const unique = uniqueValues(encountered);
  let value = null;
  let source = null;
  if (observed) {
    value = observed.value;
    source = observed.field;
  } else if (defined) {
    value = defined.value;
    source = defined.field;
  } else if (unique.length === 1) {
    value = unique[0];
    source = 'components';
  } else if (unique.length > 1) {
    value = unique;
    source = 'components';
  }
  return {
    value,
    id:probeId(value),
    details:isObject(value) ? value : null,
    provided:observed !== null || defined !== null || encountered.length > 0,
    probes:unique,
    byComponent,
    source,
    resolved:value !== null,
  };
}

function qualitySummary(item,values) {
  const own = firstField(item,QUALITY_FIELDS);
  const byComponent = {};
  for (const entry of values ?? []) {
    if (entry.quality !== undefined) byComponent[entry.id] = entry.quality;
  }
  let value = own ? own.value : null;
  let source = own ? own.field : null;
  if (value === null && isObject(item?.result)) {
    for (const field of QUALITY_FIELDS) {
      if (Object.hasOwn(item.result,field)) {
        value = item.result[field];
        source = `result.${field}`;
        break;
      }
    }
  }
  return {value,source,byComponent};
}

function unresolvedDetail(kind,reference,outcome) {
  const detail = {
    kind,
    ref:reference,
    status:outcome.status ?? null,
    reason:outcome.reason,
  };
  if (outcome.message) detail.message = outcome.message;
  return detail;
}

async function collectObservation(client,stream,item,caches,streamInfo) {
  const definitionRef = definitionReference(item);
  const locationRef = locationReference(item);
  const unresolvedDetails = [];
  const issues = [];
  let definition = inlineDefinition(item);

  if (!definition && definitionRef !== null) {
    const resolved = await resolveDefinition(client,definitionRef,caches.definitions);
    if (resolved.ok) definition = resolved.value;
    else unresolvedDetails.push(unresolvedDetail('definition',definitionRef,resolved));
  } else if (!definition) {
    unresolvedDetails.push(unresolvedDetail('definition',null,
      {status:null,reason:'not-provided',message:null}));
  }

  const components = definition ? normalizedComponents(definition) : null;
  const resultProvided = Object.hasOwn(item,'result') && item.result !== undefined;
  const result = item.result === undefined ? null : item.result;
  let mapped = {values:null,extraValues:[],issues:[],completeResult:false};
  if (components) {
    const observationQuality = firstField(item,QUALITY_FIELDS)?.value;
    mapped = mapResult(components,result,resultProvided,observationQuality);
  } else if (resultProvided) {
    mapped.issues.push({kind:'result',reason:'definition-unresolved'});
  }

  let location = inlineLocation(item);
  if (!location && locationRef !== null) {
    const resolved = await resolveLocation(client,locationRef,caches.locations);
    if (resolved.ok) location = resolved.value;
    else unresolvedDetails.push(unresolvedDetail('location',locationRef,resolved));
  } else if (!location) {
    unresolvedDetails.push(unresolvedDetail('location',null,
      {status:null,reason:'not-provided',message:null}));
  }

  const probes = probeSummary(item,definition,components ?? []);
  const quality = qualitySummary(item,mapped.values);

  const unresolved = unresolvedDetails.map(detail => detail.kind);
  const status = unresolved.length ? 'unresolved' : 'resolved';
  const complete = status === 'resolved' && mapped.completeResult;
  const observationId = String(item.observationId);
  const phenomenonTime = item.phenomenonTime === undefined ? null : item.phenomenonTime;
  const associations = {
    definition:{ref:definitionRef,resolved:definition !== null,value:definition},
    location:{ref:locationRef,resolved:location !== null,value:location},
    probe:{resolved:probes.resolved,value:probes.value,source:probes.source},
    quality:{resolved:quality.value !== null,value:quality.value,source:quality.source},
  };
  for (const detail of unresolvedDetails) {
    const current = associations[detail.kind];
    associations[detail.kind] = {ref:current.ref,resolved:false,
      status:detail.status,reason:detail.reason,
      ...(detail.message ? {message:detail.message} : {})};
  }
  return {
    id:observationId,
    observationId,
    stream,
    streamDefinition:streamInfo.definition ?? null,
    definition:definitionRef,
    definitionRef,
    definitionVersion:definitionRef,
    definitionInfo:definition,
    definitionSnapshot:definition,
    time:phenomenonTime,
    phenomenonTime,
    values:mapped.values,
    components:mapped.values,
    extraValues:mapped.extraValues,
    result,
    rawResult:result,
    resultProvided,
    missingValues:mapped.values ? mapped.values.filter(entry => entry.missing).map(entry => entry.id) : null,
    locationRef,
    location,
    locationPoint:location?.point ?? location?.coordinates ?? null,
    locationValidAt:location?.validAt ?? location?.validFrom ?? null,
    probe:probes.value,
    probeId:probes.id,
    probeDetails:probes.details,
    probes:probes.probes,
    probeByComponent:probes.byComponent,
    probeSource:probes.source,
    probeResolved:probes.resolved,
    quality:quality.value,
    qualityFlag:quality.value,
    qualitySource:quality.source,
    qualityByComponent:quality.byComponent,
    associations,
    status,
    interpretable:status === 'resolved',
    resolved:status === 'resolved',
    complete,
    partial:status === 'resolved' && !complete,
    completeResult:mapped.completeResult,
    valuesResolved:mapped.values !== null,
    unresolved,
    missingAssociations:unresolved,
    unresolvedDetails,
    issues:[...mapped.issues,...issues],
  };
}

export async function collect(client,options = {}) {
  const stream = options.stream ?? options.streamId ?? DEFAULT_STREAM;
  const streamBody = await client(`/streams/${encodeURIComponent(stream)}`);
  const streamInfo = {
    id:stream,
    definition:isObject(streamBody) && streamBody.definition !== undefined ? streamBody.definition : null,
  };
  const items = await readObservations(client,stream,options);
  const caches = {definitions:new Map(),locations:new Map()};
  const rows = [];
  const seen = new Set();
  for (const item of items) {
    if (!isObject(item) || item.observationId === undefined || item.observationId === null ||
      String(item.observationId) === '') continue;
    const row = await collectObservation(client,stream,item,caches,streamInfo);
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}
