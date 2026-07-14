export const ROADMAP_ID_PATTERN = /^P\d+(?:\.\d+){0,2}$/;

export function idSegments(id) {
  return id.slice(1).split('.').map(Number);
}

export function compareIds(a, b) {
  const left = idSegments(a);
  const right = idSegments(b);
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
