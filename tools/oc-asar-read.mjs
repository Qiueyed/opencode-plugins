// oc-asar-read.mjs: minimal read-only asar inspector for anchor re-derivation.
// Usage: node oc-asar-read.mjs <asar> list [filter]   -> file entries matching filter
//        node oc-asar-read.mjs <asar> extract <entry> <dest>
import fs from "fs";

const [,, asar, cmd, a1, a2] = process.argv;
const fh = fs.openSync(asar, "r");
const head = Buffer.alloc(16);
fs.readSync(fh, head, 0, 16, 0);
// asar: UInt32LE payloadSize(?), UInt32LE jsonSize, then JSON header
const jsonSize = head.readUInt32LE(12);
const dataBase = 8 + head.readUInt32LE(4);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fh, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString("utf8"));

const files = [];
(function walk(node, p) {
  if (node.files) for (const [name, child] of Object.entries(node.files)) walk(child, p + "/" + name);
  else files.push({ path: p, size: node.size ?? 0, offset: node.offset ?? "0" });
})(header, "");

if (cmd === "list") {
  const filter = a1 ? new RegExp(a1) : /.*/;
  for (const f of files) if (filter.test(f.path)) console.log(f.size, f.path);
} else if (cmd === "extract") {
  const entry = files.find((f) => f.path === a1);
  if (!entry) { console.error("not found:", a1); process.exit(1); }
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fh, buf, 0, entry.size, dataBase + Number(entry.offset));
  fs.writeFileSync(a2, buf);
  console.log("wrote", a2, entry.size, "bytes");
}
