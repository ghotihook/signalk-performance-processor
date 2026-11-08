// Run by `npm publish` (prepublishOnly): a prerelease version goes out only under a non-latest
// tag, and a release only under `latest`, so a beta never reaches the Signal K app store
// (which follows `latest`) and a release never hides behind `beta`.
//   npm publish --tag beta   for x.y.z-beta.n
//   npm publish              for x.y.z
const { version } = require('../package.json')
const tag = process.env.npm_config_tag || 'latest'
const pre = version.includes('-')
if (pre && tag === 'latest') {
  console.error(`\n${version} is a prerelease: publish it with  npm publish --tag beta  (a plain publish would put it on the app store)\n`)
  process.exit(1)
}
if (!pre && tag !== 'latest') {
  console.error(`\n${version} is a release: publish it with a plain  npm publish  (not --tag ${tag})\n`)
  process.exit(1)
}
console.log(`publishing ${version} under the "${tag}" tag`)
