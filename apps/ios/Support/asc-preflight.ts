#!/usr/bin/env bun
/**
 * Proves the App Store Connect key works before anything slow depends on it.
 *
 * An archive takes minutes and signing happens at the end of it, so a key with
 * the wrong role, a mistyped issuer, or a missing app record otherwise surfaces
 * as a failure long after the thing that caused it. This asks the API the three
 * questions directly, in about a second.
 *
 * Never prints the key, and never sends it anywhere: the private key only ever
 * signs a short-lived token locally.
 */
const keyId = process.env.ASC_KEY_ID;
const issuerId = process.env.ASC_ISSUER_ID;
const keyPath = process.env.ASC_KEY_PATH;

if (!keyId || !issuerId || !keyPath) {
  console.error("Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH first.");
  process.exit(1);
}

const bundleId = "nerdev.com.AgentDeck";

const pem = await Bun.file(keyPath.replace(/^~/, process.env.HOME ?? "~")).text();
const der = Uint8Array.from(
  atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
  (character) => character.charCodeAt(0),
);

const key = await crypto.subtle.importKey(
  "pkcs8",
  der,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);

const base64url = (value: string) =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
// Apple rejects a token valid for more than 20 minutes; this needs seconds.
const payload = base64url(
  JSON.stringify({ iss: issuerId, iat: now, exp: now + 300, aud: "appstoreconnect-v1" }),
);
const signature = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  key,
  new TextEncoder().encode(`${header}.${payload}`),
);
const token = `${header}.${payload}.${base64url(
  String.fromCharCode(...new Uint8Array(signature)),
)}`;

const call = async (path: string) => {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const apps = await call("/v1/apps?limit=200");
if (apps.status === 401) {
  console.error(
    "✗ The key was refused. Check the Key ID and Issuer ID, and that the .p8 matches the Key ID.",
  );
  process.exit(1);
}
if (apps.status !== 200) {
  console.error(
    `✗ App Store Connect answered ${apps.status}:`,
    JSON.stringify(apps.body).slice(0, 400),
  );
  process.exit(1);
}
console.log("✓ key accepted");

// SAFETY: App Store Connect list endpoints answer a JSON:API `data` array;
// every field is read optionally, so a shape drift degrades to "not found".
const found = (
  apps.body as { data?: Array<{ attributes?: { bundleId?: string; name?: string } }> }
).data?.find((app) => app.attributes?.bundleId === bundleId);
if (found) {
  console.log(`✓ app record exists: ${found.attributes?.name} (${bundleId})`);
} else {
  console.error(
    `✗ no app record for ${bundleId}. Create it in App Store Connect: My Apps → + → New App.`,
  );
}

// Creating certificates is what a Developer-role key cannot do, and it is the
// step the archive depends on, so it is worth checking rather than assuming.
const certificates = await call("/v1/certificates?limit=200");
if (certificates.status === 200) {
  // SAFETY: same JSON:API `data` array; an unexpected shape reads as "no
  // distribution certificate yet", which the message below already covers.
  const distribution = (
    certificates.body as { data?: Array<{ attributes?: { certificateType?: string } }> }
  ).data?.filter((certificate) =>
    ["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(certificate.attributes?.certificateType ?? ""),
  );
  console.log(
    distribution?.length
      ? `✓ ${distribution.length} distribution certificate(s) on the account`
      : "· no distribution certificate yet — automatic signing will create one",
  );
} else {
  console.error(
    `✗ cannot read certificates (${certificates.status}). The key probably has the Developer role; it needs App Manager.`,
  );
}

if (!found) process.exit(1);

// Top-level await needs module scope; the script exports nothing.
export {};
