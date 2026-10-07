// Wraps src/app.html (the page body, also published as a Claude artifact) into a full document for Firebase Hosting.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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
</body>
</html>
`;
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
writeFileSync(new URL("../public/index.html", import.meta.url), html);
console.log("Built public/index.html");
