const manifest = require("./package.json");
function required(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(
      `Signed releases require ${name}. Unsigned packaging remains npm run package.`,
    );
  return value;
}
const identity = required("MACOS_SIGNING_IDENTITY").replace(
  /^Developer ID Application:\s*/,
  "",
);
required("MACOS_TEAM_ID");
required("APPLE_API_KEY");
required("APPLE_API_KEY_ID");
required("APPLE_API_ISSUER");
module.exports = {
  ...manifest.build,
  directories: { ...manifest.build.directories, output: "release-signed" },
  forceCodeSigning: true,
  artifactName: "Local-Build-Desk-${version}-${arch}.${ext}",
  mac: {
    ...manifest.build.mac,
    identity,
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    notarize: true,
  },
  dmg: { sign: true },
};
