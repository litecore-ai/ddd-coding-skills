import { createHash } from 'node:crypto';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
}

export function canonicalStringify(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

export function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function specHash(spec) {
  const acceptanceCriteria = [...spec.acceptanceCriteria]
    .map(criterion => ({ ...criterion, covers: [...criterion.covers].sort() }))
    .sort((left, right) => compareText(left.id, right.id));
  const sharedContracts = [...spec.sharedContracts]
    .map(reference => ({ path: reference.path, hash: reference.hash }))
    .sort((left, right) => compareText(left.path, right.path));
  const models = [...spec.models]
    .map(model => ({
      ...model,
      fields: model.fields
        .map(field => ({ ...field, constraints: [...field.constraints].sort() }))
        .sort((left, right) => compareText(left.name, right.name))
    }))
    .sort((left, right) => compareText(left.name, right.name));
  const contracts = [...spec.contracts]
    .map(contract => ({ ...contract, errors: [...contract.errors].sort() }))
    .sort((left, right) => compareText(left.name, right.name));
  return sha256({
    schemaVersion: spec.schemaVersion,
    id: spec.id,
    acceptanceCriteria,
    models,
    contracts,
    sharedContracts,
    consumers: [...spec.consumers].sort()
  });
}
