export class RoadmapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoadmapError';
    this.code = code;
    this.details = details;
  }
}

export const EXIT_CODES = Object.freeze({ OK: 0, USAGE: 2, INVALID: 3, BLOCKED: 4, FAILED: 5, CONFLICT: 6, INTERNAL: 70 });
