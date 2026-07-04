#!/usr/bin/env node
// Generates a VAPID keypair for Web Push and prints it as ready-to-paste .env
// lines. Run with `pnpm vapid:generate`. VAPID_SUBJECT is left for you to fill
// in with a contact URL (mailto: or https:) that push services can reach.
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("# VAPID keys for Web Push — add these to your .env");
console.log("# VAPID_SUBJECT must be a mailto: or https: URL you control.");
console.log('VAPID_SUBJECT="mailto:you@example.com"');
console.log(`VAPID_PRIVATE_KEY="${privateKey}"`);
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY="${publicKey}"`);
