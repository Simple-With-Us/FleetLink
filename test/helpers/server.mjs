/** Serve the worker over real HTTP on localhost, for clients such as the CLI. */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handleRequest } from "../../worker/index.mjs";

export async function serve(env) {
  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else if (value != null) headers.set(key, value);
      }
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: "half"
      });
      const waits = [];
      const response = await handleRequest(request, env, { waitUntil: (p) => waits.push(p) });
      await Promise.allSettled(waits);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err?.stack || err));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
