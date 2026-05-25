import getPort, { portNumbers } from "get-port";

/**
 * Allocate `count` distinct free ports inside the configured range. We pre-call
 * `get-port` sequentially with already-claimed ports tracked locally so a
 * single allocation pass never hands out the same port twice — important
 * because `get-port` only consults the OS, and the surrounding test process
 * doesn't `listen()` on the ports until later.
 */
export async function allocatePorts(min: number, max: number, count: number): Promise<number[]> {
  const range = portNumbers(min, max);
  const taken = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const port = await getPort({ port: range, exclude: [...taken] });
    taken.add(port);
    out.push(port);
  }
  return out;
}
