export type TimingFields = Record<string, unknown>;

export type TimingRecord = {
  name: string;
  ms: number;
  fields?: TimingFields;
};

export type TimingSink = (name: string, ms: number, fields?: TimingFields) => void;

export type TimingCollector = {
  readonly records: TimingRecord[];
  readonly add: TimingSink;
  elapsedMs(): number;
  serverTimingHeader(): string;
  time<T>(name: string, fn: () => Promise<T>, fields?: TimingFields): Promise<T>;
  timeSync<T>(name: string, fn: () => T, fields?: TimingFields): T;
};

export function createTimingCollector(): TimingCollector {
  const startedAt = performance.now();
  const records: TimingRecord[] = [];
  const add: TimingSink = (name, ms, fields) => {
    records.push({ name, ms: Math.max(0, Math.round(ms)), ...(fields ? { fields } : {}) });
  };

  return {
    records,
    add,
    elapsedMs: () => Math.max(0, Math.round(performance.now() - startedAt)),
    serverTimingHeader: () => records.map((record) => `${serverTimingToken(record.name)};dur=${record.ms}`).join(", "),
    time: async (name, fn, fields) => timeWithSink(add, name, fn, fields),
    timeSync: (name, fn, fields) => timeSyncWithSink(add, name, fn, fields),
  };
}

export async function timeWithSink<T>(
  sink: TimingSink | undefined,
  name: string,
  fn: () => Promise<T>,
  fields?: TimingFields,
): Promise<T> {
  if (!sink) return fn();
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    sink(name, performance.now() - startedAt, fields);
  }
}

export function timeSyncWithSink<T>(sink: TimingSink | undefined, name: string, fn: () => T, fields?: TimingFields): T {
  if (!sink) return fn();
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    sink(name, performance.now() - startedAt, fields);
  }
}

function serverTimingToken(name: string): string {
  const token = name.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, "_");
  return token.length > 0 ? token : "stage";
}
