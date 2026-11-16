import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

const MAX_HISTORY = 50;
const MAX_CONFLICTS = 50;
const REQUIRED_ASSOCIATIONS = ['definition','location'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function same(left,right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digestOf(row,provenance) {
  return createHash('sha256').update(JSON.stringify({row,provenance})).digest('hex');
}

function truncate(list,limit) {
  if (list.length > limit) list.splice(0,list.length - limit);
}

function addEvent(entry,kind,detail = {}) {
  entry.history.push({at:new Date().toISOString(),kind,...detail});
  truncate(entry.history,MAX_HISTORY);
}

function addConflict(entry,field,detail = {}) {
  entry.conflictCount++;
  entry.conflicts.push({at:new Date().toISOString(),field,...detail});
  truncate(entry.conflicts,MAX_CONFLICTS);
  addEvent(entry,'conflict',{field,...detail});
}

function componentMap(values) {
  return new Map((values ?? []).map(value => [value.id,value]));
}

function valuesComplete(values) {
  return Array.isArray(values) && values.every(value => !value.missing);
}

function valueState(values) {
  if (!Array.isArray(values)) return {missing:null,complete:false};
  return {missing:values.filter(value => value.missing).map(value => value.id),
    complete:valuesComplete(values)};
}

function statusOf(entry) {
  if (REQUIRED_ASSOCIATIONS.some(field => entry[field] === null)) return 'unresolved';
  return valuesComplete(entry.values) ? 'confirmed' : 'partial';
}

function refresh(entry) {
  const state = valueState(entry.values);
  entry.missingValues = state.missing;
  entry.completeValues = state.complete;
  entry.interpretable = REQUIRED_ASSOCIATIONS.every(field => entry[field] !== null);
  entry.status = statusOf(entry);
  entry.updatedAt = new Date().toISOString();
}

function newEntry(row,provenance,digest) {
  const now = new Date().toISOString();
  return {
    id:String(row.id),
    observationId:row.observationId ?? String(row.id),
    stream:row.stream ?? null,
    time:row.time ?? row.phenomenonTime ?? null,
    definitionRef:row.definitionVersion ?? row.definitionRef ?? row.definition ?? null,
    locationRef:row.locationRef ?? null,
    definition:null,
    location:null,
    probe:null,
    probeByComponent:{},
    quality:null,
    qualityByComponent:{},
    values:null,
    missingValues:null,
    completeValues:false,
    extraValues:[],
    issues:[],
    associations:[],
    status:'unresolved',
    interpretable:false,
    conflictCount:0,
    conflicts:[],
    seenCount:0,
    firstSeen:now,
    updatedAt:now,
    provenance:clone(provenance ?? null),
    digest,
    history:[],
  };
}

function mergeAssociation(entry,field,value) {
  if (!value) return;
  if (entry[field] === null) {
    entry[field] = clone(value);
    if (!entry.associations.includes(field)) entry.associations.push(field);
    addEvent(entry,'association-filled',{field});
    return;
  }
  if (!same(entry[field],value)) addConflict(entry,field,{reason:'already-recorded'});
}

function mergeQuality(entry,row) {
  if (row.quality === undefined || row.quality === null) return;
  if (entry.quality === null) entry.quality = clone(row.quality);
  else if (!same(entry.quality,row.quality)) addConflict(entry,'quality',{reason:'already-recorded'});
  if (isObject(row.qualityByComponent)) {
    for (const [id,value] of Object.entries(row.qualityByComponent)) {
      if (entry.qualityByComponent[id] === undefined) entry.qualityByComponent[id] = clone(value);
      else if (!same(entry.qualityByComponent[id],value)) {
        addConflict(entry,'quality',{component:id,reason:'already-recorded'});
      }
    }
  }
}

function mergeProbe(entry,row) {
  if (row.probe !== undefined && row.probe !== null) {
    if (entry.probe === null) {
      entry.probe = clone(row.probe);
      if (!entry.associations.includes('probe')) entry.associations.push('probe');
      addEvent(entry,'association-filled',{field:'probe'});
    } else if (!same(entry.probe,row.probe)) {
      addConflict(entry,'probe',{reason:'already-recorded'});
    }
  }
  if (isObject(row.probeByComponent)) {
    for (const [id,value] of Object.entries(row.probeByComponent)) {
      if (entry.probeByComponent[id] === undefined) {
        entry.probeByComponent[id] = clone(value);
        if (!entry.associations.includes('probe')) entry.associations.push('probe');
      } else if (!same(entry.probeByComponent[id],value)) {
        addConflict(entry,'probe',{component:id,reason:'already-recorded'});
      }
    }
  }
}

function mergeValues(entry,row) {
  if (!Array.isArray(row.values)) return;
  if (!Array.isArray(entry.values)) {
    entry.values = clone(row.values);
    return;
  }
  const current = componentMap(entry.values);
  const incoming = componentMap(row.values);
  if (current.size !== incoming.size || [...current.keys()].some(id => !incoming.has(id))) {
    addConflict(entry,'values',{reason:'component-set-changed'});
    return;
  }
  const merged = entry.values.map(existing => {
    const candidate = incoming.get(existing.id);
    if (existing.unit !== candidate.unit) {
      addConflict(entry,'values',{component:existing.id,reason:'unit-changed',
        recorded:existing.unit,incoming:candidate.unit});
      return existing;
    }
    if (existing.missing && !candidate.missing) {
      addEvent(entry,'value-filled',{component:existing.id});
      return clone(candidate);
    }
    if (!existing.missing && candidate.missing) {
      addConflict(entry,'values',{component:existing.id,reason:'value-withdrawn',
        recorded:clone(existing.value)});
      return existing;
    }
    if (!existing.missing && !candidate.missing && !same(existing.value,candidate.value)) {
      addConflict(entry,'values',{component:existing.id,reason:'value-changed',
        recorded:clone(existing.value),incoming:clone(candidate.value)});
      return existing;
    }
    return existing;
  });
  entry.values = merged;
}

function mergeIssues(entry,row) {
  const known = new Set(entry.issues.map(issue => JSON.stringify(issue)));
  for (const issue of row.issues ?? []) {
    if (!known.has(JSON.stringify(issue))) {
      entry.issues.push(clone(issue));
      known.add(JSON.stringify(issue));
    }
  }
}

function refsAgree(entry,row) {
  if (entry.definitionRef !== null && row.definitionVersion !== undefined &&
    row.definitionVersion !== null && String(row.definitionVersion) !== String(entry.definitionRef)) {
    addConflict(entry,'definition',{reason:'identity-mismatch',
      incoming:String(row.definitionVersion),recorded:String(entry.definitionRef)});
    return false;
  }
  if (entry.locationRef !== null && row.locationRef !== undefined && row.locationRef !== null &&
    String(row.locationRef) !== String(entry.locationRef)) {
    addConflict(entry,'location',{reason:'identity-mismatch',
      incoming:String(row.locationRef),recorded:String(entry.locationRef)});
    return false;
  }
  if (entry.definitionRef === null && row.definitionVersion !== undefined && row.definitionVersion !== null) {
    entry.definitionRef = String(row.definitionVersion);
  }
  if (entry.locationRef === null && row.locationRef !== undefined && row.locationRef !== null) {
    entry.locationRef = String(row.locationRef);
  }
  return true;
}

function apply(entry,row,provenance,digest) {
  entry.seenCount++;
  entry.digest = digest;
  entry.provenance = clone(provenance ?? entry.provenance);
  if (!refsAgree(entry,row)) {
    refresh(entry);
    return;
  }
  mergeAssociation(entry,'definition',row.definitionInfo ?? row.definitionSnapshot);
  mergeAssociation(entry,'location',row.location);
  mergeProbe(entry,row);
  mergeQuality(entry,row);
  mergeValues(entry,row);
  mergeIssues(entry,row);
  if (row.extraValues?.length) {
    const known = new Set(entry.extraValues.map(value => JSON.stringify(value)));
    for (const value of row.extraValues) {
      if (!known.has(JSON.stringify(value))) entry.extraValues.push(clone(value));
    }
  }
  refresh(entry);
}

export class ObservationLedger {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }
  async list() {
    try {return JSON.parse(await readFile(join(this.directory,'observations.json'),'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return [];throw error;}
  }
  async get(id) {
    return (await this.list()).find(entry => entry.id === String(id)) ?? null;
  }
  async unresolved() {
    return (await this.list()).filter(entry => entry.status === 'unresolved');
  }
  async apply(rows, provenance) {
    const operation = this.serial.then(async () => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) {
        throw new Error('record id required');
      }
      await mkdir(this.directory,{recursive:true});
      const current = await this.list();
      const index = new Map(current.map(entry => [entry.id,entry]));
      const summary = {confirmed:0,partial:0,unresolved:0,conflicts:0,added:0,unchanged:0};
      for (const row of rows) {
        const digest = digestOf(row,provenance);
        let entry = index.get(row.id);
        if (!entry) {
          entry = newEntry(row,provenance,digest);
          current.push(entry);
          index.set(entry.id,entry);
          summary.added++;
        } else if (entry.digest === digest) {
          summary.unchanged++;
          summary[entry.status]++;
          continue;
        }
        const conflictsBefore = entry.conflictCount;
        apply(entry,row,provenance,digest);
        summary.conflicts += entry.conflictCount - conflictsBefore;
        summary[entry.status]++;
      }
      const temporary = join(this.directory,`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(current,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,join(this.directory,'observations.json'));
      return {...summary,total:current.length};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
}
