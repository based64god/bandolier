#!/usr/bin/env node
// Generate a VAPID keypair for Web Push (background notifications).
//
// Web Push requires an application server (VAPID) keypair: the public key is
// handed to browsers to create a push subscription; the private key signs the
// pushes Bandolier sends. The pair is stable — generate it once and keep it for
// the life of the deployment (rotating it invalidates every existing
// subscription, so users must re-enable notifications).
//
// Usage:
//   node scripts/generate-vapid-keys.mjs
//
// Then copy the printed values into your environment:
//   WEB_PUSH_VAPID_PUBLIC_KEY=...
//   WEB_PUSH_VAPID_PRIVATE_KEY=...
//   WEB_PUSH_CONTACT=mailto:you@example.com   # optional; identifies you to push services

import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("# Web Push (VAPID) keys — add these to your environment.");
console.log("# Keep the private key secret; it signs every push you send.\n");
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY="${publicKey}"`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY="${privateKey}"`);
