// The changelog generator: `@changesets/cli`'s default (a release line per changeset, with
// its commit), except that a dependent package gets no "Updated dependencies [hash]" line.
// The nine packages are one fixed group whose peer dependency on core is the exact version
// (RELEASING.md), so every package is "updated" by every changeset, and a line per changeset
// that names no change would bury the real entries.
import changelogGit from '@changesets/cli/changelog'

export default {
  getReleaseLine: changelogGit.getReleaseLine,
  getDependencyReleaseLine: () => Promise.resolve(''),
}
