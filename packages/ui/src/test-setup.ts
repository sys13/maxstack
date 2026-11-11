// Register jest-dom's matchers on the `expect` this test run uses.
//
// `import '@testing-library/jest-dom/vitest'` extends whichever `vitest` *jest-dom*
// resolves, which is not always the runner's. This repo is also checked out as a
// submodule of a larger workspace, and when that outer workspace installs last,
// packages/ui/node_modules links into its store: jest-dom then extends the outer
// `vitest` while the run uses this repo's, and every DOM matcher fails with
// "Invalid Chai property". Importing `expect` here resolves from this file, the
// same way the tests themselves import it, so the matchers land on the right one.
import * as matchers from '@testing-library/jest-dom/matchers'
import { expect } from 'vitest'
import '@testing-library/jest-dom/vitest' // its `expect` type augmentation

// The module's typings are `export =`, so TypeScript adds a synthetic `default`
// member to the namespace that the ESM build doesn't have and that isn't a
// matcher. Leave it out of what reaches `expect.extend`.
const { default: _syntheticDefault, ...domMatchers } = matchers
expect.extend(domMatchers)
