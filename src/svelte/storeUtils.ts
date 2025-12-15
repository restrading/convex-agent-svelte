import { fromStore, readable, type Readable, type Unsubscriber } from "svelte/store";

export type MaybeReadable<T> = T | Readable<T>;

export function subscribeToValue<T>(
  value: MaybeReadable<T>,
  handler: (next: T) => void,
): Unsubscriber {
  if (isReadable(value)) {
    return value.subscribe(handler);
  }
  handler(value);
  return () => {};
}

export function getCurrentValue<T>(value: MaybeReadable<T>): T {
  if (isReadable(value)) {
    let current: T;
    const unsubscribe = value.subscribe((val) => {
      current = val;
    });
    unsubscribe();
    return current!;
  }
  return value;
}

export function toReadable<T>(value: MaybeReadable<T>): Readable<T> {
  if (isReadable(value)) {
    return value;
  }
  return readable(value, () => {});
}

export function toReactiveGetter<T>(value: MaybeReadable<T>): () => T {
  if (isReadable(value)) {
    const storeValue = fromStore(value);
    return () => storeValue.current;
  }
  return () => value;
}

function isReadable<T>(value: MaybeReadable<T>): value is Readable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "subscribe" in value &&
    typeof (value as Readable<T>).subscribe === "function"
  );
}
