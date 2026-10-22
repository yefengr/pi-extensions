export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const property of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[property]);
  }
  return Object.freeze(value);
}
