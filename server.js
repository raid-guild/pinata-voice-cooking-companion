import { createServer } from "node:http";
import next from "next";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    if (req.url === "/health" || req.url === "/app/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, app: "pinata-voice-cooking-companion", route: "/app" }));
      return;
    }

    handle(req, res);
  }).listen(port, host, () => {
    console.log(`pinata-voice-cooking-companion listening on ${host}:${port}`);
  });
});
