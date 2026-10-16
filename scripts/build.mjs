// Wraps src/app.html (the page body, also published as a Claude artifact) into a full document for Firebase Hosting,
// bundles web/auth.js (sign-in and Firestore sync, web only) and web/admin.js, and builds the admin page.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const body = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Business English flashcards with Repeat and Learned piles and AI-generated decks.">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
<script type="module" src="/auth.js"></script>
</body>
</html>
`;
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
writeFileSync(new URL("../public/index.html", import.meta.url), html);
// The admin page shares the app's colour tokens and base styles (everything before "/* Top bar */" in app.html).
const tokens = body.slice(body.indexOf(":root {"), body.indexOf("/* Top bar */"));
const admin = readFileSync(new URL("../web/admin.html", import.meta.url), "utf8").replace("/*TOKENS*/", tokens);
writeFileSync(new URL("../public/admin.html", import.meta.url), admin);

for (const name of ["auth", "admin"]) {
  await build({
    entryPoints: [new URL(`../web/${name}.js`, import.meta.url).pathname],
    outfile: new URL(`../public/${name}.js`, import.meta.url).pathname,
    bundle: true, format: "esm", minify: true, target: "es2020", legalComments: "none",
  });
}
console.log("Built public/index.html, public/admin.html, public/auth.js and public/admin.js");
