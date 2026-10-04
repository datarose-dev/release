export class ReleaseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReleaseError';
  }
}

export function invariant(condition, message) {
  if (!condition) throw new ReleaseError(message);
}
