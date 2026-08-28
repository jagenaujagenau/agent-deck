#!/usr/bin/env bun
/**
 * Creates the distribution certificate and App Store profile the release signs
 * with, and installs both locally.
 *
 * Xcode's automatic export wants a *cloud-managed* distribution certificate,
 * and the account only hands those to a key with the Admin role — an App
 * Manager key is refused with "You haven't been given access to cloud-managed
 * distribution certificates". The same key is allowed to mint an ordinary
 * distribution certificate through the API, so that is what this does.
 *
 * Run it once, and again when the certificate expires (Apple issues them for a
 * year). The profile is always rebuilt, because a profile pins the certificates
 * it was made with and one built against a replaced certificate cannot sign.
 *
 * Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH, same as the release script.
 */
import { $ } from "bun";

const BUNDLE_ID = "nerdev.com.AgentDeck";
const PROFILE_NAME = "Agent Deck App Store";
const TEAM_ID = "T7AG6F3KVC";
const DISTRIBUTION_TYPES = ["DISTRIBUTION", "IOS_DISTRIBUTION"];

const keyId = process.env.ASC_KEY_ID;
const issuerId = process.env.ASC_ISSUER_ID;
const keyPath = process.env.ASC_KEY_PATH?.replace(/^~/, process.env.HOME ?? "~");
if (!keyId || !issuerId || !keyPath) {
  console.error("Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH first.");
  process.exit(1);
}

const pem = await Bun.file(keyPath).text();
const der = Uint8Array.from(
  atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
  (character) => character.charCodeAt(0),
);
const signingKey = await crypto.subtle.importKey(
  "pkcs8",
  der,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);
const base64url = (value: string) =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const issuedAt = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
const claims = base64url(
  JSON.stringify({ iss: issuerId, iat: issuedAt, exp: issuedAt + 600, aud: "appstoreconnect-v1" }),
);
const signature = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  signingKey,
  new TextEncoder().encode(`${header}.${claims}`),
);
const token = `${header}.${claims}.${base64url(String.fromCharCode(...new Uint8Array(signature)))}`;

/** The JSON this script sends: literal JSON:API envelopes, nothing dynamic. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The slice of an App Store Connect resource this script reads. */
type AscResource = {
  id: string;
  attributes?: {
    certificateType?: string;
    expirationDate?: string;
    certificateContent?: string;
    uuid?: string;
    profileContent?: string;
  };
};
type AscDocument = { data?: AscResource | AscResource[] };

const items = (document: AscDocument): AscResource[] =>
  Array.isArray(document.data) ? document.data : [];
const item = (document: AscDocument): AscResource | undefined =>
  Array.isArray(document.data) ? document.data[0] : document.data;

const call = async (method: string, path: string, body?: Json) => {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body) headers.set("content-type", "application/json");
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  // SAFETY: every endpoint this script talks to answers a JSON:API document
  // whose `data` member carries the resource(s); the fields named above are
  // the ones read, and anything else rides along unexamined.
  const document = (await response.json().catch(() => ({}))) as AscDocument;
  return { status: response.status, body: document };
};

const fail = (label: string, result: { status: number; body: unknown }): never => {
  console.error(`x ${label}: ${result.status}`, JSON.stringify(result.body).slice(0, 500));
  process.exit(1);
};

// ---- bundle id ------------------------------------------------------------
const bundles = await call(
  "GET",
  `/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}`,
);
let bundle = item(bundles.body);
if (bundle) {
  console.log("- bundle id already registered");
} else {
  const created = await call("POST", "/v1/bundleIds", {
    data: {
      type: "bundleIds",
      attributes: { identifier: BUNDLE_ID, name: "Agent Deck", platform: "IOS", seedId: TEAM_ID },
    },
  });
  if (created.status !== 201) fail("registering the bundle id", created);
  bundle = item(created.body);
  console.log(`- registered bundle id ${BUNDLE_ID}`);
}

// ---- certificate ----------------------------------------------------------
// A certificate the account knows about is only useful if this machine holds
// its private key; otherwise it can be listed but never signed with.
const localIdentities = await $`security find-identity -v -p codesigning`.text();
const certificates = await call("GET", "/v1/certificates?limit=200");
if (certificates.status !== 200) fail("listing certificates", certificates);
const usable = items(certificates.body).filter(
  (certificate) =>
    DISTRIBUTION_TYPES.includes(certificate.attributes?.certificateType ?? "") &&
    localIdentities.includes("Apple Distribution"),
);

let certificateId: string;
if (usable.length > 0) {
  certificateId = usable[0]!.id;
  console.log(
    `- reusing distribution certificate ${certificateId} (expires ${usable[0]!.attributes!.expirationDate})`,
  );
} else {
  // Apple wants an RSA 2048 CSR; the private key never leaves this machine.
  const scratch = `${process.env.TMPDIR ?? "/tmp"}/agentdeck-signing-${Date.now()}`;
  await $`mkdir -p ${scratch}`.quiet();
  await $`openssl req -new -newkey rsa:2048 -nodes -keyout ${scratch}/dist.key -out ${scratch}/dist.csr -subj ${`/CN=Agent Deck Distribution/O=${TEAM_ID}/C=US`}`.quiet();
  const csr = (await Bun.file(`${scratch}/dist.csr`).text())
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const created = await call("POST", "/v1/certificates", {
    data: {
      type: "certificates",
      attributes: { certificateType: "DISTRIBUTION", csrContent: csr },
    },
  });
  if (created.status !== 201) fail("creating the distribution certificate", created);
  const certificate = item(created.body)!;
  certificateId = certificate.id;
  await Bun.write(
    `${scratch}/dist.cer`,
    Buffer.from(certificate.attributes!.certificateContent!, "base64"),
  );
  await $`openssl x509 -inform DER -in ${scratch}/dist.cer -out ${scratch}/dist.pem`.quiet();
  const passphrase = crypto.randomUUID();
  await $`openssl pkcs12 -export -inkey ${scratch}/dist.key -in ${scratch}/dist.pem -out ${scratch}/dist.p12 -passout ${`pass:${passphrase}`} -name ${"Apple Distribution"}`.quiet();
  await $`security import ${scratch}/dist.p12 -k ${`${process.env.HOME}/Library/Keychains/login.keychain-db`} -P ${passphrase} -A`.quiet();
  // The private key is in the keychain now; leaving a copy on disk would be a
  // second, unguarded home for it.
  await $`rm -rf ${scratch}`.quiet();
  console.log(`- created distribution certificate ${certificateId} and imported it`);
}

// ---- profile --------------------------------------------------------------
const existing = await call(
  "GET",
  `/v1/profiles?filter[name]=${encodeURIComponent(PROFILE_NAME)}&limit=200`,
);
for (const stale of items(existing.body)) {
  await call("DELETE", `/v1/profiles/${stale.id}`);
  console.log(`- removed previous profile ${stale.id}`);
}
const profile = await call("POST", "/v1/profiles", {
  data: {
    type: "profiles",
    attributes: { name: PROFILE_NAME, profileType: "IOS_APP_STORE" },
    relationships: {
      bundleId: { data: { type: "bundleIds", id: bundle!.id } },
      certificates: { data: [{ type: "certificates", id: certificateId }] },
    },
  },
});
if (profile.status !== 201) fail("creating the provisioning profile", profile);
const attributes = item(profile.body)!.attributes!;
const destination = `${process.env.HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles/${attributes.uuid}.mobileprovision`;
await Bun.write(destination, Buffer.from(attributes.profileContent!, "base64"));
console.log(`- installed profile "${PROFILE_NAME}" (${attributes.uuid})`);
console.log("\nSigning is ready. Run Support/testflight.sh.");
