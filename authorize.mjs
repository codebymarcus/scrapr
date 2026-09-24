#!/usr/bin/env node
// One-time Google Drive authorization (Part B).
//
// Prereq: download the OAuth "Desktop app" client JSON from Google Cloud and
// save it as ./credentials.json (see README → "Upload to Google Drive").
//
//   node authorize.mjs
//
// Opens your browser once, you approve, and it writes ./token.json (with a
// long-lived refresh token) so `scrape.mjs --drive` runs non-interactively.
import { authenticate } from "@google-cloud/local-auth";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const CRED = path.resolve("credentials.json");
const TOKEN = path.resolve("token.json");
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

if (!existsSync(CRED)) {
  console.error(`Missing ${CRED}\nDownload the OAuth "Desktop app" client JSON from Google Cloud → Credentials and save it there.`);
  process.exit(1);
}

const client = await authenticate({ keyfilePath: CRED, scopes: SCOPES });
writeFileSync(TOKEN, JSON.stringify(client.credentials, null, 2));
console.log(`Authorized — saved ${TOKEN}. You can now run:  node scrape.mjs ... --drive`);
