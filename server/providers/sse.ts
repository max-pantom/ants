/** Minimal server-sent-events reader for streaming model responses. */
export async function* readSSE(res: Response, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        let event: string | undefined;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function errorText(res: Response): Promise<{ message: string; code?: string }> {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    const e = j.error ?? j;
    return { message: e.message ?? e.error_description ?? body.slice(0, 300), code: e.code ?? e.type };
  } catch {
    return { message: body.slice(0, 300) || res.statusText };
  }
}
