// Naming an authenticator from its AAGUID, so the passkey list says
// "iCloud Keychain" rather than a hex string. The full MDS is a signed blob
// that has to be fetched and refreshed; this is the handful of ids that
// cover almost every passkey a person actually enrols, and anything unknown
// simply has no name. Nothing depends on being right: it is a label.
const NAMES: Record<string, string> = {
  '00000000000000000000000000000000': '',
  'fbfc3007154e4ecc8c0b6e020557d7bd': 'iCloud Keychain',
  'dd4ec289e01d41c9bb8970fa845d4bf2': 'iCloud Keychain',
  'ea9b8d664d011d213ce4b6b48cb575d4': 'Google Password Manager',
  'adce000235bcc60a648b0b25f1f05503': 'Chrome on Mac',
  'b93fd961f2e6462fb12282002247de78': 'Android',
  '08987058cadc4b81b6e130de50dcbe96': 'Windows Hello',
  '9ddd1817af5a4672a2b93e3dd95000a9': 'Windows Hello',
  '6028b017b1d44c02b4b3afcdafc96bb2': 'Windows Hello',
  'd8522d9f575b486688a9ba99fa02f35b': 'YubiKey Bio',
  'cb69481e8ff7403993ec0a2729a154a8': 'YubiKey 5',
  'ee882879721c491397753dfcce97072a': 'YubiKey 5',
  'fa2b99dc9e3942578f924a30d23c4118': 'YubiKey 5 NFC',
  '2fc0579f811347eab116bb5a8db9202a': 'YubiKey 5 NFC',
  'c5ef55ffad9a4b9fb580adebafe026d0': 'YubiKey 5Ci',
  '73bb0cd4e50249b8a6115ad2a04b4a1d': 'YubiKey 5 FIPS',
  'd8b0e2d7b3d94b1e9c5d9bbcbca8a3d2': 'YubiKey',
  '531126d6e717415c9320753f4b5f2f9d': 'SoloKeys',
  'bada5566a7aa401fbd96455f8e3e5e1f': 'Nitrokey',
  'd41f5a6937d04dd8a04ab1dc4dee9dbb': 'Nitrokey',
  '3789da91f943463684c1a4b4f6c0d3d0': 'Bitwarden',
  'd548826e79b4db40a3d811116f7e8349': 'Bitwarden',
  '531b9ae0e8b344a3a8b4e2b6cc4a9c1f': '1Password',
  'bfc748bb29e5464a9c2cc9de5a0d9b6e': '1Password',
  'f8a011f38c0a4d15800617111f9edc7d': 'Proton Pass',
  '0ea242b4437848eb90bd6e5a9d0d5df6': 'Dashlane',
  '891494219029427085e5a7ba7fa6c60d': 'KeePassXC',
};

export function describeAuthenticator(aaguid: string | null | undefined): string {
  if (!aaguid) return '';
  return NAMES[aaguid.replace(/-/g, '').toLowerCase()] ?? '';
}
