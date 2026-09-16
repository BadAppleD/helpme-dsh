function errorMessage(reason) {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export function validateRunTargets(items) {
  const seen = new Set();
  for (const item of items) {
    if (item.session_id !== undefined && item.session_name !== undefined) {
      throw new Error("Each batch item must provide either session_id or session_name, not both");
    }
    const key = item.session_id !== undefined
      ? `id:${item.session_id}`
      : item.session_name !== undefined
        ? `name:${item.session_name.trim().toLocaleLowerCase("en-US")}`
        : undefined;
    if (key === undefined) continue;
    if (seen.has(key)) throw new Error(`Batch contains duplicate session target: ${key.slice(key.indexOf(":") + 1)}`);
    seen.add(key);
  }
}

export async function runBatch(items, run) {
  const settled = await Promise.allSettled(items.map((item) => run(item)));
  const results = settled.map((result, index) => result.status === "fulfilled"
    ? { index, ok: true, value: result.value }
    : { index, ok: false, error: errorMessage(result.reason) });
  const succeeded = results.filter((result) => result.ok).length;
  return {
    results,
    succeeded,
    failed: results.length - succeeded,
  };
}
