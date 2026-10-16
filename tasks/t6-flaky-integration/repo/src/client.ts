const PORT = Number(process.env.STATUS_PORT ?? 59999);

/** Ask the status service how it is doing. */
export async function fetchStatus(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/status`);
  if (!res.ok) throw new Error(`status service returned ${res.status}`);
  const body = (await res.json()) as { status: string };
  return body.status;
}
