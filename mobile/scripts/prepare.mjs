// Собирает папку www для Capacitor: общий веб-интерфейс из ../volna/web + движок и оболочка телефона из src.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const web = join(root, "..", "volna", "web");
const assets = join(root, "..", "volna", "assets");
const www = join(root, "www");
const SKIP = new Set(["index.html", "login.html", "party.html"]);

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of readdirSync(web)) if (!SKIP.has(f)) cpSync(join(web, f), join(www, f), { recursive: true });
cpSync(assets, join(www, "assets"), { recursive: true });
cpSync(join(root, "src"), www, { recursive: true });
const ver = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
writeFileSync(join(www, "mobile.js"), readFileSync(join(www, "mobile.js"), "utf8").replace("__VOLNA_VERSION__", ver));
const core = join(root, "node_modules", "@capacitor", "core", "dist", "capacitor.js");
if (existsSync(core)) cpSync(core, join(www, "capacitor.js"));
else writeFileSync(join(www, "capacitor.js"), "/* @capacitor/core не установлен — режим браузера */\n");

const ENGINE = ["platform", "store", "sources", "brain", "dna", "audio", "api"].map((n) => `<script src="engine/${n}.js"></script>`).join("\n");
let html = readFileSync(join(web, "index.html"), "utf8");
html = html
  .replace("<meta charset=\"utf-8\">", "<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#060a16\">")
  .replace(/\.\.\/assets\//g, "assets/")
  .replace("</head>", "<link rel=\"stylesheet\" href=\"mobile.css\">\n</head>")
  .replace("<script src=\"icons.js\"></script>", `<script src="capacitor.js"></script>\n${ENGINE}\n<script src="icons.js"></script>`)
  .replace("<script src=\"pages.js\"></script>", "<script src=\"mobile.js\"></script>\n<script src=\"pages.js\"></script>");
for (const need of ["mobile.css", "engine/api.js", "mobile.js"]) if (!html.includes(need)) { console.error("prepare: не удалось вставить", need); process.exit(1); }
writeFileSync(join(www, "index.html"), html);
console.log("www готов:", readdirSync(www).length, "файлов/папок");
