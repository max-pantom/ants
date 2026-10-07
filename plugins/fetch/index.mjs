function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function read(res) {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = type.includes("html") ? htmlToText(body) : body;
  return `${res.status} ${res.statusText} (${type || "unknown type"})\n\n${text.slice(0, 30_000)}`;
}

export const tools = {
  async get({ url }, ctx) {
    if (!/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
    ctx.assertOutbound(url, 0);
    const res = await fetch(url, { signal: ctx.signal, headers: { "user-agent": "Ants/0.1" }, redirect: "follow" });
    return read(res);
  },
  async post({ url, body, content_type = "application/json" }, ctx) {
    if (!/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
    ctx.assertOutbound(url, Buffer.byteLength(body ?? ""));
    const res = await fetch(url, { method: "POST", body, signal: ctx.signal, headers: { "content-type": content_type, "user-agent": "Ants/0.1" } });
    return read(res);
  },
};
