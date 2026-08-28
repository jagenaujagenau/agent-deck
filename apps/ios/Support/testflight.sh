#!/usr/bin/env bash
# Archives Agent Deck and uploads it to TestFlight.
#
# Everything Apple-side is done with an App Store Connect API key rather than a
# signed-in Xcode: a key can be revoked on its own, works unattended, and is the
# one credential that covers all three things this needs — creating the
# distribution certificate, creating the provisioning profile, and uploading.
#
# The key must have the **Admin** role. Export uses cloud-managed signing, and
# the account only issues those certificates to an Admin key; an App Manager key
# is refused with "You haven't been given access to cloud-managed distribution
# certificates" and the export then fails claiming no profile was found.
#
# Required in the environment:
#   ASC_KEY_ID      the key's 10-character id
#   ASC_ISSUER_ID   the issuer uuid, shown once at the top of the Keys page
#   ASC_KEY_PATH    path to the AuthKey_<KEY_ID>.p8 file
#
# Optional:
#   BUILD_NUMBER    defaults to the current UTC timestamp, which is monotonic
#                   and never collides — App Store Connect rejects a build
#                   number it has already seen, and a forgotten manual bump is
#                   the most common way a release stalls.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
archive="${here}/build/AgentDeck.xcarchive"
export_dir="${here}/build/export"

for required in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH; do
  if [ -z "${!required:-}" ]; then
    echo "error: \$$required is not set. See the comment at the top of this script." >&2
    exit 1
  fi
done

# Signing happens at the end of a multi-minute archive, so a key with the wrong
# role fails long after the thing that caused it. Ask first.
echo "==> checking the App Store Connect key"
bun run "${here}/Support/asc-preflight.ts"

rm -rf "${archive}" "${export_dir}"

echo "==> archiving build ${build}"
xcodebuild archive \
  -project "${here}/AgentDeck.xcodeproj" \
  -scheme AgentDeck \
  -destination 'generic/platform=iOS' \
  -archivePath "${archive}" \
  -allowProvisioningUpdates \
  -authenticationKeyID "${ASC_KEY_ID}" \
  -authenticationKeyIssuerID "${ASC_ISSUER_ID}" \
  -authenticationKeyPath "${ASC_KEY_PATH}" \
  CURRENT_PROJECT_VERSION="${build}"

echo "==> exporting"
xcodebuild -exportArchive \
  -archivePath "${archive}" \
  -exportPath "${export_dir}" \
  -exportOptionsPlist "${here}/Support/ExportOptions.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyID "${ASC_KEY_ID}" \
  -authenticationKeyIssuerID "${ASC_ISSUER_ID}" \
  -authenticationKeyPath "${ASC_KEY_PATH}"

echo "==> uploading to TestFlight"
# altool will not take a path to the key; it looks the file up by id in a
# directory it is told about, so point it at whichever one the key lives in.
API_PRIVATE_KEYS_DIR="$(cd "$(dirname "${ASC_KEY_PATH}")" && pwd)" \
xcrun altool --upload-app \
  --type ios \
  --file "${export_dir}/AgentDeck.ipa" \
  --apiKey "${ASC_KEY_ID}" \
  --apiIssuer "${ASC_ISSUER_ID}"

echo "==> done. Processing takes a few minutes before the build appears in TestFlight."
