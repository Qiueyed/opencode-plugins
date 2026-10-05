import fs from "fs";
import crypto from "crypto";
import { execFileSync } from "child_process";

// Usage: node verify-integrity.mjs [app-bundle-path]  (default /Applications/OpenCode.app)
const APP = process.argv[2] || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const PLIST = `${APP}/Contents/Info.plist`;

const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const header = Buffer.alloc(jsonLen);
fs.readSync(fd, header, 0, jsonLen, 16);
fs.closeSync(fd);
const actual = crypto.createHash("sha256").update(header).digest("hex");

const plistHash = execFileSync("python3", ["-c", `
import plistlib
with open("${PLIST}", "rb") as f:
    p = plistlib.load(f)
print(p["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"])
`]).toString().trim();

console.log("asar header sha256 :", actual);
console.log("Info.plist stamped :", plistHash);
console.log(actual === plistHash ? "MATCH - Electron will accept this bundle at boot" : "MISMATCH - app would refuse to launch!");
process.exit(actual === plistHash ? 0 : 1);
