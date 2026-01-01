/// <reference lib="deno.ns" />
// Simple HTTP server for demo
import { serveDir } from "jsr:@std/http/file-server";

const port = 8000;

Deno.serve({ port }, (req) => {
  return serveDir(req, {
    fsRoot: ".",
    urlRoot: "",
    showDirListing: true,
    enableCors: true,
  });
});

console.log(`\n🚀 Demo server running at http://localhost:${port}/\n`);
console.log(`   Open http://localhost:${port}/index.html in your browser\n`);
